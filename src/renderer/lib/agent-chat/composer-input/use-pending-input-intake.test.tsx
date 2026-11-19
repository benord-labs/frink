// @vitest-environment happy-dom
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PendingComposerInput, pendingComposerInputAtomFamily } from './pending-input';
import { usePendingInputIntake } from './use-pending-input-intake';

const CHAT = 'chat-1';
const TEXT: PendingComposerInput = {
  kind: 'text',
  text: 'FAIL a.test.ts',
  label: 'Terminal 1 output',
};
const PATHS: PendingComposerInput = {
  kind: 'paths',
  items: [
    { path: 'src/a.ts', type: 'file' },
    { path: 'src/lib', type: 'folder' },
  ],
};

function fakeEditor(value = '') {
  return { focus: vi.fn(), getValue: vi.fn(() => value), insertMention: vi.fn() };
}

type SetupOptions = {
  addPastedText?: () => Promise<void>;
  editor?: ReturnType<typeof fakeEditor> | null;
};

function setup(
  pending: PendingComposerInput[],
  { addPastedText = vi.fn(async () => {}), editor = fakeEditor() }: SetupOptions = {},
) {
  const store = createStore();
  store.set(pendingComposerInputAtomFamily(CHAT), pending);
  const editorRef = { current: editor };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => usePendingInputIntake({ chatId: CHAT, addPastedText, editorRef }), { wrapper });
  return {
    store,
    addPastedText,
    editor,
    queue: () => store.get(pendingComposerInputAtomFamily(CHAT)),
  };
}

describe('usePendingInputIntake', () => {
  afterEach(cleanup);

  it('adds terminal output as a labelled chip, clears it and focuses the composer', async () => {
    const { addPastedText, editor, queue } = setup([TEXT]);
    expect(addPastedText).toHaveBeenCalledExactlyOnceWith('FAIL a.test.ts', {
      label: 'Terminal 1 output',
      kind: 'terminal',
    });
    expect(queue()).toEqual([]);
    await waitFor(() => expect(editor?.focus).toHaveBeenCalledOnce());
  });

  it('says so when the output could not be saved', async () => {
    render(<Toaster />);
    const { editor } = setup([TEXT], {
      addPastedText: vi.fn(async () => Promise.reject(new Error('disk'))),
    });
    expect(await screen.findByText("Couldn't add the terminal output")).toBeTruthy();
    expect(editor?.focus).not.toHaveBeenCalled();
  });

  it('inserts one picked mention per path after focusing the composer, beside queued text', () => {
    const { addPastedText, editor, queue } = setup([TEXT, PATHS]);
    expect(addPastedText).toHaveBeenCalledOnce();
    expect(editor?.focus).toHaveBeenCalledOnce();
    expect(editor?.insertMention.mock.calls.map(([option]) => option.id)).toEqual([
      'file:local:src/a.ts',
      'folder:local:src/lib',
    ]);
    expect(editor?.focus.mock.invocationCallOrder[0]).toBeLessThan(
      editor?.insertMention.mock.invocationCallOrder[0] ?? 0,
    );
    expect(queue()).toEqual([]);
  });

  it('skips a path the composer already mentions', () => {
    const { editor } = setup([PATHS], { editor: fakeEditor('see @[file:local:src/a.ts] ') });
    expect(editor?.insertMention.mock.calls.map(([option]) => option.id)).toEqual([
      'folder:local:src/lib',
    ]);
  });

  it('keeps paths queued while no composer is mounted, and still takes the text', () => {
    const { addPastedText, queue } = setup([PATHS, TEXT], { editor: null });
    expect(addPastedText).toHaveBeenCalledOnce();
    expect(queue()).toEqual([PATHS]);
  });

  it('adds a path queued twice before the intake runs only once', () => {
    const { editor } = setup([PATHS, PATHS]);
    expect(editor?.insertMention.mock.calls.map(([option]) => option.id)).toEqual([
      'file:local:src/a.ts',
      'folder:local:src/lib',
    ]);
  });

  it('says so instead of adding a name the message would cut short', async () => {
    render(<Toaster />);
    const { editor } = setup([
      {
        kind: 'paths',
        items: [
          { path: 'src/a]b.ts', type: 'file' },
          { path: 'src/ok.ts', type: 'file' },
        ],
      },
    ]);
    expect(editor?.insertMention.mock.calls.map(([option]) => option.id)).toEqual([
      'file:local:src/ok.ts',
    ]);
    expect(await screen.findByText(/Couldn't add a\]b\.ts/)).toBeTruthy();
  });

  it('keeps what was sent after the render and before the intake ran', () => {
    const store = createStore();
    const pendingAtom = pendingComposerInputAtomFamily(CHAT);
    store.set(pendingAtom, [TEXT]);
    const late: PendingComposerInput = { kind: 'text', text: 'late', label: 'Terminal 2 output' };
    let sent = false;
    // The intake reads the editor first, so a send made here lands between render and effect.
    const editorRef = {
      get current() {
        if (!sent) {
          sent = true;
          store.set(pendingAtom, (prev) => [...prev, late]);
        }
        return null;
      },
    };
    const addPastedText = vi.fn(async (_text: string) => {});
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    renderHook(() => usePendingInputIntake({ chatId: CHAT, addPastedText, editorRef }), {
      wrapper,
    });
    expect(addPastedText.mock.calls.map(([text]) => text)).toEqual(['FAIL a.test.ts', 'late']);
    expect(store.get(pendingAtom)).toEqual([]);
  });
});
