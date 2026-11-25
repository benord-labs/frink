// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fileKey,
  openFileAtom,
  openFilesAtom,
  pendingCloseKeysAtom,
  pendingLeaveAtom,
  requestCloseAllFilesAtom,
  requestCloseFilesAtom,
  requestLeaveAtom,
  updateFileContentAtom,
} from '@/lib/code-editor/state';
import { UnsavedChangesDialog } from './index';

afterEach(cleanup);

const key = fileKey('src/a.ts', '/repo');

/** One unsaved tab whose close is waiting on the prompt. */
function renderPrompt(saveOpenFile = vi.fn(async () => true)) {
  const store = createStore();
  store.set(openFileAtom, {
    path: 'src/a.ts',
    name: 'a.ts',
    projectPath: '/repo',
    intent: 'pinned',
  });
  store.set(updateFileContentAtom, { key, content: 'edited' });
  store.set(requestCloseFilesAtom, [key]);
  const { unmount } = render(
    <Provider store={store}>
      <UnsavedChangesDialog saveOpenFile={saveOpenFile} />
    </Provider>,
  );
  return { store, saveOpenFile, unmount };
}

describe('UnsavedChangesDialog with several unsaved tabs', () => {
  it('closes the tabs that saved and keeps the one that failed', async () => {
    const store = createStore();
    for (const name of ['a.ts', 'b.ts']) {
      const path = `src/${name}`;
      store.set(openFileAtom, { path, name, projectPath: '/repo', intent: 'pinned' });
      store.set(updateFileContentAtom, { key: fileKey(path, '/repo'), content: 'edited' });
    }
    store.set(requestCloseAllFilesAtom);
    const bKey = fileKey('src/b.ts', '/repo');
    render(
      <Provider store={store}>
        <UnsavedChangesDialog saveOpenFile={vi.fn(async (k: string) => k !== bKey)} />
      </Provider>,
    );

    expect(screen.getByText('Save changes to 2 files?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(store.get(pendingCloseKeysAtom)).toBeNull());
    expect(store.get(openFilesAtom).map((f) => f.name)).toEqual(['b.ts']);
  });
});

describe('UnsavedChangesDialog', () => {
  it('names the file it asks about', () => {
    renderPrompt();

    expect(screen.getByText('Save changes to a.ts?')).toBeInTheDocument();
  });

  it('saves, then closes the tab', async () => {
    const { store, saveOpenFile } = renderPrompt();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(store.get(openFilesAtom)).toEqual([]));
    expect(saveOpenFile).toHaveBeenCalledWith(key);
    expect(store.get(pendingCloseKeysAtom)).toBeNull();
  });

  it('keeps the tab and its edits when the save fails', async () => {
    const { store } = renderPrompt(vi.fn(async () => false));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(store.get(pendingCloseKeysAtom)).toBeNull());
    expect(store.get(openFilesAtom)[0]).toMatchObject({ content: 'edited', isDirty: true });
  });

  it("closes the tab without saving on Don't save", () => {
    const { store, saveOpenFile } = renderPrompt();

    fireEvent.click(screen.getByRole('button', { name: "Don't save" }));

    expect(store.get(openFilesAtom)).toEqual([]);
    expect(saveOpenFile).not.toHaveBeenCalled();
  });

  it('leaves a newer prompt up when a save from a dismissed one finishes', async () => {
    let finishWrite = (_saved: boolean) => {};
    const { store, unmount } = renderPrompt(
      vi.fn(() => new Promise<boolean>((resolve) => (finishWrite = resolve))),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    unmount();
    const newer = ['src/b.ts'];
    store.set(pendingCloseKeysAtom, newer);

    await act(async () => finishWrite(true));

    expect(store.get(pendingCloseKeysAtom)).toBe(newer);
    // Leaving counted as Cancel, so the finished write does not close the tab.
    expect(store.get(openFilesAtom)).toHaveLength(1);
  });

  it('answers Cancel when the editor unmounts with the prompt open, so later closes still work', () => {
    const { store, unmount } = renderPrompt();

    unmount();

    expect(store.get(pendingCloseKeysAtom)).toBeNull();
    expect(store.get(openFilesAtom)[0]).toMatchObject({ content: 'edited', isDirty: true });
  });

  it('keeps the tab and its edits on Cancel', () => {
    const { store, saveOpenFile } = renderPrompt();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(store.get(openFilesAtom)[0]).toMatchObject({ content: 'edited', isDirty: true });
    expect(store.get(pendingCloseKeysAtom)).toBeNull();
    expect(saveOpenFile).not.toHaveBeenCalled();
  });
});

describe('UnsavedChangesDialog when the window is leaving', () => {
  const confirmLeave = vi.fn();
  const cancelLeave = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, { desktopApi: { confirmLeave, cancelLeave } });
  });

  /** Two unsaved tabs, and Frink quitting. */
  function renderLeave(saveOpenFile = vi.fn(async (_key: string) => true)) {
    const store = createStore();
    for (const name of ['a.ts', 'b.ts']) {
      const path = `src/${name}`;
      store.set(openFileAtom, { path, name, projectPath: '/repo', intent: 'pinned' });
      store.set(updateFileContentAtom, { key: fileKey(path, '/repo'), content: 'edited' });
    }
    expect(store.set(requestLeaveAtom, 'quit')).toBe(true);
    const { unmount } = render(
      <Provider store={store}>
        <UnsavedChangesDialog saveOpenFile={saveOpenFile} />
      </Provider>,
    );
    return { store, saveOpenFile, unmount };
  }

  it('saves every unsaved tab, then lets the quit go ahead', async () => {
    const { store, saveOpenFile } = renderLeave();
    expect(screen.getByText('Save changes to 2 files?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(confirmLeave).toHaveBeenCalledTimes(1));
    expect(saveOpenFile).toHaveBeenCalledTimes(2);
    expect(cancelLeave).not.toHaveBeenCalled();
    expect(store.get(pendingLeaveAtom)).toBeNull();
  });

  it('stays open when one tab did not save', async () => {
    const bKey = fileKey('src/b.ts', '/repo');
    renderLeave(vi.fn(async (k: string) => k !== bKey));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(cancelLeave).toHaveBeenCalledTimes(1));
    expect(confirmLeave).not.toHaveBeenCalled();
  });

  it('stays open when a save throws partway, after an earlier tab saved', async () => {
    const bKey = fileKey('src/b.ts', '/repo');
    renderLeave(
      vi.fn(async (k: string) => {
        if (k === bKey) throw new Error('refresh failed');
        return true;
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(cancelLeave).toHaveBeenCalledTimes(1));
    expect(confirmLeave).not.toHaveBeenCalled();
  });

  it("lets the quit go ahead without saving on Don't save", () => {
    const { saveOpenFile } = renderLeave();

    fireEvent.click(screen.getByRole('button', { name: "Don't save" }));

    expect(confirmLeave).toHaveBeenCalledTimes(1);
    expect(saveOpenFile).not.toHaveBeenCalled();
  });

  it('cancels the quit on Cancel, keeping the tabs', () => {
    const { store } = renderLeave();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(cancelLeave).toHaveBeenCalledTimes(1);
    expect(confirmLeave).not.toHaveBeenCalled();
    expect(store.get(openFilesAtom)).toHaveLength(2);
  });

  it('cancels the quit exactly once when the prompt unmounts during a save', async () => {
    let finishWrite = (_saved: boolean) => {};
    const { unmount } = renderLeave(
      vi.fn(() => new Promise<boolean>((resolve) => (finishWrite = resolve))),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    unmount();

    await act(async () => finishWrite(true));

    expect(cancelLeave).toHaveBeenCalledTimes(1);
    expect(confirmLeave).not.toHaveBeenCalled();
  });

  it('drops a tab a running Save wrote from a quit prompt that replaced it, then quits on Save', async () => {
    const store = createStore();
    for (const name of ['a.ts', 'b.ts']) {
      const path = `src/${name}`;
      store.set(openFileAtom, { path, name, projectPath: '/repo', intent: 'pinned' });
      store.set(updateFileContentAtom, { key: fileKey(path, '/repo'), content: 'edited' });
    }
    const aKey = fileKey('src/a.ts', '/repo');
    let finishWrite = (_saved: boolean) => {};
    // Like useSaveOpenFile: a tab that is no longer open cannot be saved.
    const saveOpenFile = vi.fn((k: string) =>
      k === aKey && saveOpenFile.mock.calls.length === 1
        ? new Promise<boolean>((resolve) => (finishWrite = resolve))
        : Promise.resolve(
            store.get(openFilesAtom).some((f) => fileKey(f.path, f.projectPath) === k),
          ),
    );
    store.set(requestCloseFilesAtom, [aKey]);
    render(
      <Provider store={store}>
        <UnsavedChangesDialog saveOpenFile={saveOpenFile} />
      </Provider>,
    );
    // Cmd+W → Save on a.ts, then Cmd+Q while that write is still running.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    act(() => {
      store.set(requestLeaveAtom, 'quit');
    });
    await act(async () => finishWrite(true));

    expect(screen.getByText('Save changes to b.ts?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(confirmLeave).toHaveBeenCalledTimes(1));
    expect(cancelLeave).not.toHaveBeenCalled();
  });
});
