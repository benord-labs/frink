// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { trpc } from '../../../lib/trpc';
import { ChatInputArea } from './chat-input-area';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

/** A real trpc client that never answers: the composer's account, model and command queries stay
 *  loading, which is all these tests need. */
function createIdleClient() {
  return trpc.createClient({ links: [() => () => observable(() => undefined)] });
}

afterEach(cleanup);

const selection = {
  id: 'sel-1',
  text: 'const a = 1;',
  filePath: '/repo/src/send.ts',
  fileName: 'send.ts',
  language: 'typescript',
  startLine: 279,
  endLine: 282,
  preview: 'const a = 1;',
  createdAt: new Date(0),
};

function composerProps(
  over: Partial<ComponentProps<typeof ChatInputArea>> = {},
): ComponentProps<typeof ChatInputArea> {
  return {
    editorRef: { current: null },
    fileInputRef: { current: null },
    onSend: vi.fn(),
    onForceSend: vi.fn(),
    onStop: vi.fn(async () => undefined),
    onCompact: vi.fn(),
    isStreaming: false,
    isCompacting: false,
    images: [],
    files: [],
    onAddAttachments: vi.fn(),
    onRemoveImage: vi.fn(),
    onRemoveFile: vi.fn(),
    isUploading: false,
    textContexts: [],
    onRemoveTextContext: vi.fn(),
    messageTokenData: { contextTokens: 0, contextWindow: null, promptCacheExpiresAt: null },
    subChatId: 'sub-chat-1',
    parentChatId: 'chat-1',
    projectPath: '/repo',
    changedFiles: [],
    codeSelectionContext: null,
    onClearCodeSelection: vi.fn(),
    activeFileName: null,
    activeFileDismissed: false,
    onDismissActiveFile: vi.fn(),
    ...over,
  };
}

function renderComposer(over: Partial<ComponentProps<typeof ChatInputArea>> = {}) {
  const props = composerProps(over);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <trpc.Provider client={createIdleClient()} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ChatInputArea {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { props, ...view };
}

/** The footer control row: Mode, Auto and Model sit in it, and the editor chip must not. */
function footerRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('.flex-nowrap');
  if (!row) throw new Error('composer footer row not found');
  return row;
}

describe('ChatInputArea editor context', () => {
  it('shows the open file above the text box with a remove control, outside the footer row', () => {
    const { props, container } = renderComposer({ activeFileName: 'notes.md' });

    const remove = screen.getByRole('button', { name: 'Remove notes.md from context' });
    expect(remove.className).not.toContain('sr-only');
    expect(footerRow(container)).not.toContainElement(remove);
    expect(within(footerRow(container)).queryByText('notes.md')).not.toBeInTheDocument();

    fireEvent.click(remove);
    expect(props.onDismissActiveFile).toHaveBeenCalledOnce();
  });

  it('shows nothing for a file the user removed, matching what the send path attaches', () => {
    renderComposer({ activeFileName: 'notes.md', activeFileDismissed: true });

    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /from context/ })).not.toBeInTheDocument();
  });

  it('shows a code selection in place of the file, and removing it removes both', () => {
    const { props } = renderComposer({
      activeFileName: 'notes.md',
      codeSelectionContext: selection,
    });

    expect(screen.getByText('L279-282')).toBeInTheDocument();
    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove code selection and file from context: send.ts lines 279-282',
      }),
    );
    expect(props.onClearCodeSelection).toHaveBeenCalledOnce();
    expect(props.onDismissActiveFile).toHaveBeenCalledOnce();
  });
});
