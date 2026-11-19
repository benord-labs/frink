// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '../../test-utils/render-with-trpc';
import { fileKey, type OpenFile, openFilesAtom, updateFileContentAtom } from '../state/atoms';
import { type SaveOpenFile, useSaveOpenFile } from './use-save-open-file';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

type Store = ReturnType<typeof createStore>;

/** Saves `file` through the hook, with /selected as the selected project; `answer` plays main. */
async function save(
  file: OpenFile,
  answer: (op: Operation, store: Store) => Promise<null> = async () => null,
) {
  const store = createStore();
  store.set(openFilesAtom, [{ ...file, content: 'edited', isDirty: true }]);
  const asked = vi.fn((op: Operation) => answer(op, store));
  const onSavedInProject = vi.fn();
  let saveOpenFile: SaveOpenFile | undefined;
  function Probe() {
    saveOpenFile = useSaveOpenFile('/selected', onSavedInProject);
    return null;
  }
  renderWithTrpc(
    <Provider store={store}>
      <Probe />
      <Toaster />
    </Provider>,
    asked,
  );
  let saved = false;
  await act(async () => {
    saved = (await saveOpenFile?.(fileKey(file.path, file.projectPath))) ?? false;
  });
  const writes = asked.mock.calls
    .map(([op]) => op)
    .filter((op) => op.path === 'files.writeFile')
    .map((op) => op.input);
  return { saved, store, onSavedInProject, writes };
}

describe('useSaveOpenFile', () => {
  it('writes the tab into its own project and marks it saved', async () => {
    const { saved, store, onSavedInProject, writes } = await save({
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
    });

    expect(saved).toBe(true);
    expect(writes).toEqual([{ filePath: '/repo/src/a.ts', content: 'edited' }]);
    expect(store.get(openFilesAtom)[0]?.isDirty).toBe(false);
    expect(onSavedInProject).toHaveBeenCalledWith('/repo');
  });

  it('keeps the tab unsaved and says so when the write fails', async () => {
    const { saved, store } = await save(
      { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' },
      async (op) => {
        if (op.path === 'files.writeFile') throw new Error('EACCES');
        return null;
      },
    );

    expect(saved).toBe(false);
    expect(store.get(openFilesAtom)[0]).toMatchObject({ content: 'edited', isDirty: true });
    expect(await screen.findByText('Failed to save file')).toBeInTheDocument();
  });

  it('keeps the tab unsaved when it is edited while the write runs', async () => {
    const key = fileKey('src/a.ts', '/repo');
    const { saved, store } = await save(
      { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' },
      async (op, store) => {
        if (op.path === 'files.writeFile') {
          store.set(updateFileContentAtom, { key, content: 'edited again' });
        }
        return null;
      },
    );

    expect(saved).toBe(false);
    expect(store.get(openFilesAtom)[0]).toMatchObject({ content: 'edited again', isDirty: true });
  });

  it('never writes a kept tab with no folder into the selected project', async () => {
    const { saved, writes } = await save({ path: 'src/a.ts', name: 'a.ts', isOtherProject: true });

    expect(saved).toBe(false);
    expect(writes).toEqual([]);
    expect(
      await screen.findByText("Couldn't save: this file's folder is unknown"),
    ).toBeInTheDocument();
  });

  it.each(['/abs/a.ts', 'C:\\abs\\a.ts'])(
    'still writes a kept tab with no folder at its absolute path %s',
    async (path) => {
      const { saved, writes } = await save({ path, name: 'a.ts', isOtherProject: true });

      expect(saved).toBe(true);
      expect(writes).toEqual([{ filePath: path, content: 'edited' }]);
    },
  );
});
