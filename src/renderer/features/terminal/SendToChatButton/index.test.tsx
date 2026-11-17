// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/lib/trpc';
import { TooltipProvider } from '@/components/ui/tooltip';
import { pendingTerminalOutputAtomFamily } from '@/lib/terminal/pending-output';
import {
  registerTerminalInstance,
  type TerminalReader,
  unregisterTerminalInstance,
} from '@/lib/terminal/terminal-instances';
import { activeTerminalIdAtom, terminalsAtom } from '../atoms';
import { TerminalSidebar } from '../terminal-sidebar';
import type { TerminalInstance } from '../types';
import { SendToChatButton } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const CHAT = 'chat-1';
const terminal: TerminalInstance = {
  id: 't1',
  paneId: `${CHAT}:term:t1`,
  name: 'Terminal 1',
  createdAt: 0,
};

function fakeXterm(selection: string, rows: string[]): TerminalReader {
  return {
    getSelection: () => selection,
    buffer: {
      active: {
        length: rows.length,
        getLine: (row) => {
          const text = rows.at(row);
          return text === undefined
            ? undefined
            : { isWrapped: false, translateToString: () => text };
        },
      },
    },
  };
}

function renderButton(xterm: TerminalReader | null, onSent = vi.fn()) {
  if (xterm) registerTerminalInstance(terminal.paneId, xterm);
  const store = createStore();
  render(
    <Provider store={store}>
      <TooltipProvider>
        <SendToChatButton chatId={CHAT} terminal={terminal} onSent={onSent} />
      </TooltipProvider>
      <Toaster />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send selection or recent output to chat' }));
  if (xterm) unregisterTerminalInstance(terminal.paneId);
  return { pending: store.get(pendingTerminalOutputAtomFamily(CHAT)), onSent };
}

describe('SendToChatButton', () => {
  afterEach(cleanup);

  it('sends exactly the selection when there is one', () => {
    const { pending, onSent } = renderButton(
      fakeXterm('expected 1\nreceived 2\n\n', ['$ bun test']),
    );
    expect(pending).toEqual({ text: 'expected 1\nreceived 2', label: 'Terminal 1 selection' });
    expect(onSent).toHaveBeenCalledOnce();
  });

  it('sends the recent output when nothing is selected', () => {
    const { pending } = renderButton(fakeXterm('', ['$ bun test', 'FAIL a.test.ts', '$']));
    expect(pending).toEqual({ text: '$ bun test\nFAIL a.test.ts\n$', label: 'Terminal 1 output' });
  });

  it('says the terminal has no output yet, and sends nothing, for an empty pane', async () => {
    const { pending, onSent } = renderButton(fakeXterm('', ['', '']));
    expect(pending).toBeNull();
    expect(onSent).not.toHaveBeenCalled();
    expect(await screen.findByText('This terminal has no output yet')).toBeTruthy();
  });

  it('does nothing for a pane that is not mounted', () => {
    const { pending, onSent } = renderButton(null);
    expect(pending).toBeNull();
    expect(onSent).not.toHaveBeenCalled();
  });
});

describe('TerminalSidebar in a narrow window', () => {
  afterEach(cleanup);

  it('sends from the fullscreen terminal and goes back to the chat', () => {
    const store = createStore();
    store.set(terminalsAtom, { [CHAT]: [terminal] });
    store.set(activeTerminalIdAtom, { [CHAT]: terminal.id });
    registerTerminalInstance(terminal.paneId, fakeXterm('', ['FAIL a.test.ts']));
    const onClose = vi.fn();
    const queryClient = new QueryClient();
    // A client whose calls never answer: the closed panel mounts no terminal session.
    const client = trpc.createClient({ links: [() => () => observable(() => undefined)] });
    render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Provider store={store}>
            <TooltipProvider>
              <TerminalSidebar
                chatId={CHAT}
                cwd="/repo"
                workspaceId="w"
                isMobileFullscreen
                onClose={onClose}
              />
            </TooltipProvider>
          </Provider>
        </QueryClientProvider>
      </trpc.Provider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Send selection or recent output to chat' }),
    );
    unregisterTerminalInstance(terminal.paneId);

    expect(store.get(pendingTerminalOutputAtomFamily(CHAT))).toEqual({
      text: 'FAIL a.test.ts',
      label: 'Terminal 1 output',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
