// @vitest-environment happy-dom
import { createStore } from 'jotai';
import type * as Monaco from 'monaco-editor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeFilePathAtom, fileKey, openFileAtom, openFilesAtom } from '@/lib/code-editor/state';
import { type CodeNavigationOpener, registerCodeNavigationOpener } from './register-editor-opener';

const PROJECT = '/repo';

function setup() {
  const store = createStore();
  let opener: CodeNavigationOpener | undefined;
  const monaco = {
    editor: {
      registerEditorOpener: (o: CodeNavigationOpener) => {
        opener = o;
        return { dispose: () => undefined };
      },
    },
  };
  registerCodeNavigationOpener(monaco, { store, getProjectPath: () => PROJECT });
  return {
    store,
    navigate(fromAbs: string, toAbs: string, position?: Monaco.IRange | Monaco.IPosition) {
      const source = { getModel: () => ({ uri: { toString: () => `file://${fromAbs}` } }) };
      const resource = { path: toAbs, toString: () => `file://${toAbs}` };
      return opener?.openCodeEditor(source, resource, position);
    },
  };
}

function tabs(store: ReturnType<typeof createStore>) {
  return store.get(openFilesAtom).map((f) => ({ path: f.path, isPreview: f.isPreview }));
}

describe('registerCodeNavigationOpener', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the tab being read when jumping to a definition in another file', () => {
    const { store, navigate } = setup();
    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: PROJECT });

    expect(navigate('/repo/src/a.ts', '/repo/src/b.ts')).toBe(true);

    expect(tabs(store)).toEqual([
      { path: 'src/a.ts', isPreview: false },
      { path: 'src/b.ts', isPreview: true },
    ]);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/b.ts', PROJECT));
  });

  it('leaves the jump target as a preview that the next tree click replaces', () => {
    const { store, navigate } = setup();
    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: PROJECT });
    navigate('/repo/src/a.ts', '/repo/src/b.ts');

    store.set(openFileAtom, { path: 'src/c.ts', name: 'c.ts', projectPath: PROJECT });

    expect(tabs(store)).toEqual([
      { path: 'src/a.ts', isPreview: false },
      { path: 'src/c.ts', isPreview: true },
    ]);
  });

  it('pins a source tab that was opened by absolute path', () => {
    const { store, navigate } = setup();
    store.set(openFileAtom, { path: '/repo/src/a.ts', name: 'a.ts', projectPath: PROJECT });

    navigate('/repo/src/a.ts', '/repo/src/b.ts');

    expect(tabs(store)).toEqual([
      { path: '/repo/src/a.ts', isPreview: false },
      { path: 'src/b.ts', isPreview: true },
    ]);
  });

  it('declines same-file and empty targets without pinning anything', () => {
    const { store, navigate } = setup();
    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: PROJECT });
    const before = store.get(openFilesAtom);

    expect(navigate('/repo/src/a.ts', '/repo/src/a.ts')).toBe(false);
    expect(navigate('/repo/src/a.ts', '')).toBe(false);

    expect(store.get(openFilesAtom)).toBe(before);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/a.ts', PROJECT));
  });

  // Monaco's Uri.path is already decoded, so a second decode throws on '%' or rewrites '%20'.
  it.each(['src/100%.ts', 'src/a%20b.ts'])(
    'opens a target named %s under its literal name',
    (rel) => {
      const { store, navigate } = setup();
      store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: PROJECT });

      expect(navigate('/repo/src/a.ts', `/repo/${rel}`)).toBe(true);

      expect(store.get(activeFilePathAtom)).toBe(fileKey(rel, PROJECT));
    },
  );

  it('opens the target in the source tab’s pane and chat', () => {
    const { store, navigate } = setup();
    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: PROJECT,
      sourcePaneIndex: 0,
      sourceChatId: 'c1',
      isWorktreeContext: true,
    });

    navigate('/repo/src/a.ts', '/repo/src/b.ts');

    const target = store.get(openFilesAtom).find((f) => f.path === 'src/b.ts');
    expect(target).toMatchObject({
      sourcePaneIndex: 0,
      sourceChatId: 'c1',
      isWorktreeContext: true,
    });
  });

  it.each([
    [
      'a one-line range',
      { startLineNumber: 42, startColumn: 14, endLineNumber: 42, endColumn: 20 },
      { lineNumber: 42, startColumn: 14, endColumn: 20 },
    ],
    ['a position', { lineNumber: 7, column: 3 }, { lineNumber: 7, startColumn: 3, endColumn: 3 }],
    [
      'a multi-line range',
      { startLineNumber: 5, startColumn: 9, endLineNumber: 8, endColumn: 2 },
      { lineNumber: 5, startColumn: 9, endColumn: 9 },
    ],
  ])('reveals the line and columns of %s', (_label, position, expected) => {
    const { store, navigate } = setup();
    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: PROJECT });
    const reveal = vi.fn();
    window.addEventListener('editor:reveal-line', reveal);

    navigate('/repo/src/a.ts', '/repo/src/b.ts', position);

    window.removeEventListener('editor:reveal-line', reveal);
    expect(reveal).toHaveBeenCalledTimes(1);
    // SAFETY: the listener only receives editor:reveal-line CustomEvents.
    const event = reveal.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({ filePath: '/repo/src/b.ts', ...expected });
  });
});
