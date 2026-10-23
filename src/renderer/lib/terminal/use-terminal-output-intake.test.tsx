// @vitest-environment happy-dom
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingTerminalOutputAtomFamily } from './pending-output';
import { useTerminalOutputIntake } from './use-terminal-output-intake';

const CHAT = 'chat-1';
const PENDING = { text: 'FAIL a.test.ts', label: 'Terminal 1 output' };

function setup(addPastedText = vi.fn(async () => {})) {
  const store = createStore();
  store.set(pendingTerminalOutputAtomFamily(CHAT), PENDING);
  const focusEditor = vi.fn();
  const editorRef = { current: { focus: focusEditor } };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => useTerminalOutputIntake({ chatId: CHAT, addPastedText, editorRef }), {
    wrapper,
  });
  return { store, addPastedText, focusEditor };
}

describe('useTerminalOutputIntake', () => {
  afterEach(cleanup);

  it('adds the output as a labelled chip, clears it and focuses the composer', async () => {
    const { store, addPastedText, focusEditor } = setup();
    expect(addPastedText).toHaveBeenCalledOnce();
    expect(addPastedText).toHaveBeenCalledWith(PENDING.text, {
      label: 'Terminal 1 output',
      kind: 'terminal',
    });
    expect(store.get(pendingTerminalOutputAtomFamily(CHAT))).toBeNull();
    await waitFor(() => expect(focusEditor).toHaveBeenCalledOnce());
  });

  it('says so when the output could not be saved', async () => {
    render(<Toaster />);
    const { focusEditor } = setup(vi.fn(async () => Promise.reject(new Error('disk'))));
    expect(await screen.findByText("Couldn't add the terminal output")).toBeTruthy();
    expect(focusEditor).not.toHaveBeenCalled();
  });
});
