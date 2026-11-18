import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { arrangeTabsByProject } from '@/lib/code-editor/tabs';
import { getFullPath } from '../files/model-path';
import {
  activeFilePathAtom,
  clearPaneContextAtom,
  closeFileAtom,
  closeFilesOutsideProjectAtom,
  codeEditorMaximizedAtom,
  codeEditorOpenAtom,
  editorActivePaneIndexAtom,
  editorIsSplitActiveAtom,
  fileKey,
  markFileSavedAtom,
  openFileAtom,
  openFilesAtom,
  tagOpenFilesWithPaneContextAtom,
  updateFileContentAtom,
} from './atoms';

/** A file from ros-service opened from chat A, whose own project is /repo. */
const browsedTab = {
  path: 'src/b.ts',
  name: 'b.ts',
  projectPath: '/ros-service',
  sourceChatId: 'chat-a',
  isOtherProject: true,
};

describe('code-editor preview tabs', () => {
  it('opens files as preview tabs by default', () => {
    const store = createStore();

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.isPreview).toBe(true);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/a.ts', '/repo'));
  });

  it('replaces existing preview tab in same pane', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      sourcePaneIndex: 0,
      sourceChatId: 'chat-1',
    });
    store.set(openFileAtom, {
      path: 'src/b.ts',
      name: 'b.ts',
      projectPath: '/repo',
      sourcePaneIndex: 0,
      sourceChatId: 'chat-1',
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/b.ts');
    expect(files[0]?.isPreview).toBe(true);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/b.ts', '/repo'));
  });

  it('replaces existing preview tab in single-pane mode (undefined pane index)', () => {
    const store = createStore();

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });
    store.set(openFileAtom, { path: 'src/b.ts', name: 'b.ts', projectPath: '/repo' });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/b.ts');
    expect(files[0]?.isPreview).toBe(true);
  });

  it('keeps one preview tab per pane', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      sourcePaneIndex: 0,
    });
    store.set(openFileAtom, {
      path: 'src/b.ts',
      name: 'b.ts',
      projectPath: '/repo',
      sourcePaneIndex: 1,
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.isPreview)).toBe(true);
  });

  it('pins a preview reopened into a pane that already has its own preview', () => {
    const store = createStore();
    const open = (path: string, sourcePaneIndex: number) =>
      store.set(openFileAtom, { path, name: path, projectPath: '/repo', sourcePaneIndex });

    open('src/a.ts', 0);
    open('src/b.ts', 1);
    open('src/b.ts', 0);

    const pane0 = store.get(openFilesAtom).filter((f) => f.sourcePaneIndex === 0);
    expect(pane0.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(pane0.filter((f) => f.isPreview).map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('pins when opening with explicit pinned intent', () => {
    const store = createStore();

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });
    store.set(openFileAtom, {
      path: 'src/c.ts',
      name: 'c.ts',
      projectPath: '/repo',
      intent: 'pinned',
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(2);
    const pinned = files.find((f) => f.path === 'src/c.ts');
    expect(pinned?.isPreview).toBe(false);
  });

  it('promotes already-open preview tab to pinned when reopened as pinned', () => {
    const store = createStore();

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });
    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      intent: 'pinned',
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/a.ts');
    expect(files[0]?.isPreview).toBe(false);
  });

  it('dedupes the same file when opened as absolute then relative under one project', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: '/repo/worktree/src/a.ts',
      name: 'a.ts',
      projectPath: '/repo/worktree',
      sourceChatId: 'chat-ai',
      isWorktreeContext: true,
      intent: 'pinned',
    });
    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo/worktree',
      sourcePaneIndex: 0,
      intent: 'preview',
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.sourceChatId).toBe('chat-ai');
    expect(files[0]?.isWorktreeContext).toBe(true);
  });

  it('dedupes equivalent windows absolute and relative paths', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'C:\\repo\\worktree\\src\\a.ts',
      name: 'a.ts',
      projectPath: 'C:\\repo\\worktree',
      intent: 'pinned',
    });
    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: 'C:/repo/worktree',
      intent: 'preview',
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
  });

  it('dedupes when existing absolute tab has no projectPath', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: '/repo/worktree/src/a.ts',
      name: 'a.ts',
      sourceChatId: 'chat-ai',
      isWorktreeContext: true,
      intent: 'pinned',
    });
    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo/worktree',
      sourceChatId: 'chat-ai',
      isWorktreeContext: false,
      intent: 'preview',
    });

    // The tab takes the folder and its path inside it, so its breadcrumb matches a tree open's.
    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/a.ts');
    expect(files[0]?.projectPath).toBe('/repo/worktree');
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/a.ts', '/repo/worktree'));
    expect(files[0]?.sourceChatId).toBe('chat-ai');
    expect(files[0]?.isWorktreeContext).toBe(true);
  });

  it('uses latest chat metadata when same canonical file is reopened from another pane', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: '/repo/worktree/src/a.ts',
      name: 'a.ts',
      projectPath: '/repo/worktree',
      sourcePaneIndex: 0,
      sourceChatId: 'chat-1',
      isWorktreeContext: true,
      intent: 'pinned',
    });

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo/worktree',
      sourcePaneIndex: 1,
      sourceChatId: 'chat-2',
      isWorktreeContext: false,
      intent: 'preview',
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.sourcePaneIndex).toBe(1);
    expect(files[0]?.sourceChatId).toBe('chat-2');
    expect(files[0]?.isWorktreeContext).toBe(true);
  });

  // A chat in /code names the file from its own folder; a chat elsewhere names it from app's.
  it("keeps a tab's path with its own folder when a nested project's folder opens the same file", () => {
    const store = createStore();
    store.set(openFileAtom, {
      path: 'app/src/a.ts',
      name: 'a.ts',
      projectPath: '/code',
      sourceChatId: 'chat-code',
      intent: 'pinned',
    });

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/code/app',
      sourceChatId: 'chat-web',
      isOtherProject: true,
      intent: 'pinned',
    });

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    const [tab] = files;
    expect(getFullPath(tab?.projectPath, tab?.path ?? '')).toBe('/code/app/src/a.ts');
    expect(store.get(activeFilePathAtom)).toBe(fileKey(tab?.path ?? '', tab?.projectPath));
    expect(tab).toMatchObject({ sourceChatId: 'chat-web', isOtherProject: true });
  });

  it('remains idempotent under rapid mixed canonical open calls', () => {
    const store = createStore();

    for (let i = 0; i < 10; i += 1) {
      store.set(openFileAtom, {
        path: i % 2 === 0 ? '/repo/worktree/src/a.ts' : 'src/a.ts',
        name: 'a.ts',
        projectPath: '/repo/worktree',
        sourceChatId: 'chat-load-test',
        isWorktreeContext: i % 2 === 0,
        intent: i % 3 === 0 ? 'pinned' : 'preview',
      });
    }

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.sourceChatId).toBe('chat-load-test');
    expect(files[0]?.isWorktreeContext).toBe(true);
  });

  it('promotes preview tab to pinned on edit', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      content: 'const a = 1;',
    });
    const key = fileKey('src/a.ts', '/repo');

    store.set(updateFileContentAtom, { key, content: 'const a = 2;' });

    const file = store.get(openFilesAtom)[0];
    expect(file?.isDirty).toBe(true);
    expect(file?.isPreview).toBe(false);
  });

  it('promotes preview tab to pinned on save marker', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      content: 'const a = 1;',
    });
    const key = fileKey('src/a.ts', '/repo');

    store.set(markFileSavedAtom, key);

    const file = store.get(openFilesAtom)[0];
    expect(file?.isDirty).toBe(false);
    expect(file?.isPreview).toBe(false);
  });

  it('clears preview state when tabs are re-tagged with pane context', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      content: 'const a = 1;',
    });
    // Simulate legacy/transition state that can exist before split retagging.
    const existing = store.get(openFilesAtom)[0];
    if (!existing) throw new Error('expected file to be opened');
    store.set(openFilesAtom, [
      {
        ...existing,
        isPreview: true,
      },
    ]);

    store.set(tagOpenFilesWithPaneContextAtom, [
      { projectPath: '/repo', paneIndex: 1, chatId: 'chat-1' },
    ]);

    const file = store.get(openFilesAtom)[0];
    expect(file?.sourcePaneIndex).toBe(1);
    expect(file?.isPreview).toBe(false);
  });
});

describe('closeFilesOutsideProjectAtom', () => {
  it('keeps files when projectPath metadata matches worktree path', () => {
    const store = createStore();

    store.set(openFileAtom, { path: 'src/base.ts', name: 'base.ts', projectPath: '/repo/base' });
    store.set(openFileAtom, {
      path: 'src/wt.ts',
      name: 'wt.ts',
      projectPath: '/repo/.frink/worktrees/a',
    });

    store.set(closeFilesOutsideProjectAtom, '/repo/.frink/worktrees/a');

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/wt.ts');
    expect(files[0]?.projectPath).toBe('/repo/.frink/worktrees/a');
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/wt.ts', '/repo/.frink/worktrees/a'));
  });

  it('normalizes project paths before comparison', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'C:\\repo\\worktree\\src\\a.ts',
      name: 'a.ts',
      projectPath: 'C:\\repo\\worktree\\',
      intent: 'pinned',
    });
    store.set(openFileAtom, {
      path: '/other/project/src/b.ts',
      name: 'b.ts',
      projectPath: '/other/project',
      intent: 'pinned',
    });

    store.set(closeFilesOutsideProjectAtom, 'C:/repo/worktree');

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('a.ts');
  });

  it('treats Windows project paths case-insensitively', () => {
    const store = createStore();

    store.set(openFileAtom, {
      path: 'C:\\Repo\\Worktree\\src\\a.ts',
      name: 'a.ts',
      projectPath: 'C:\\Repo\\Worktree',
      intent: 'pinned',
    });
    store.set(openFileAtom, {
      path: 'C:\\Other\\src\\b.ts',
      name: 'b.ts',
      projectPath: 'C:\\Other',
      intent: 'pinned',
    });

    store.set(closeFilesOutsideProjectAtom, 'c:/repo/worktree');

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('a.ts');
  });

  it('closes all files and editor when project path is null', () => {
    const store = createStore();

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });
    expect(store.get(codeEditorOpenAtom)).toBe(true);

    store.set(closeFilesOutsideProjectAtom, null);

    expect(store.get(openFilesAtom)).toEqual([]);
    expect(store.get(activeFilePathAtom)).toBeNull();
    expect(store.get(codeEditorOpenAtom)).toBe(false);
  });

  it("leaves another project's tabs to their chat, and still closes ordinary ones", () => {
    const store = createStore();
    store.set(openFileAtom, { ...browsedTab, intent: 'pinned' });
    store.set(openFileAtom, {
      path: 'src/c.ts',
      name: 'c.ts',
      projectPath: '/third',
      intent: 'pinned',
    });

    store.set(closeFilesOutsideProjectAtom, '/repo');

    expect(store.get(openFilesAtom).map((f) => f.projectPath)).toEqual(['/ros-service']);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/b.ts', '/ros-service'));
  });

  it("closes another project's tabs too when project path is null", () => {
    const store = createStore();
    store.set(openFileAtom, { ...browsedTab, intent: 'pinned' });

    store.set(closeFilesOutsideProjectAtom, null);

    expect(store.get(openFilesAtom)).toEqual([]);
    expect(store.get(codeEditorOpenAtom)).toBe(false);
  });
});

describe("another project's tab flag", () => {
  it('is cleared when a chat reopens the file without it', () => {
    const store = createStore();
    store.set(openFileAtom, { ...browsedTab, intent: 'pinned' });

    store.set(openFileAtom, { ...browsedTab, sourceChatId: 'chat-b', isOtherProject: undefined });

    const [file] = store.get(openFilesAtom);
    expect(file?.isOtherProject).toBeUndefined();
    expect(file?.sourceChatId).toBe('chat-b');
  });

  it('is kept when an open from no chat lands on the tab', () => {
    const store = createStore();
    store.set(openFileAtom, { ...browsedTab, intent: 'pinned' });

    store.set(openFileAtom, { path: 'src/b.ts', name: 'b.ts', projectPath: '/ros-service' });

    const [file] = store.get(openFilesAtom);
    expect(file?.isOtherProject).toBe(true);
    expect(file?.sourceChatId).toBe('chat-a');
  });

  it('is carried by a new tab', () => {
    const store = createStore();

    store.set(openFileAtom, { ...browsedTab, intent: 'pinned' });

    expect(store.get(openFilesAtom)[0]?.isOtherProject).toBe(true);
  });

  it('comes from the incoming file when a preview tab is replaced', () => {
    const store = createStore();
    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });

    store.set(openFileAtom, browsedTab);
    expect(store.get(openFilesAtom).map((f) => [f.path, f.isOtherProject])).toEqual([
      ['src/b.ts', true],
    ]);

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });
    expect(store.get(openFilesAtom).map((f) => [f.path, f.isOtherProject])).toEqual([
      ['src/a.ts', undefined],
    ]);
  });

  it('keeps the tab out of pane re-tagging', () => {
    const store = createStore();
    store.set(openFileAtom, { ...browsedTab, intent: 'pinned' });
    const before = store.get(openFilesAtom);

    store.set(tagOpenFilesWithPaneContextAtom, [
      { projectPath: '/ros-service', paneIndex: 1, chatId: 'chat-b' },
    ]);

    expect(store.get(openFilesAtom)).toBe(before);
  });
});

describe('clearPaneContextAtom', () => {
  it('clears pane index but preserves sourceChatId', () => {
    const store = createStore();

    store.set(openFilesAtom, [
      {
        path: 'src/a.ts',
        name: 'a.ts',
        projectPath: '/repo',
        content: 'const a = 1;',
        sourcePaneIndex: 1,
        sourceChatId: 'chat-1',
        isWorktreeContext: true,
        isPreview: false,
      },
    ]);

    store.set(clearPaneContextAtom);

    const file = store.get(openFilesAtom)[0];
    expect(file?.sourcePaneIndex).toBeUndefined();
    expect(file?.sourceChatId).toBe('chat-1');
    expect(file?.isWorktreeContext).toBe(true);
  });

  it('is a no-op when pane metadata is absent', () => {
    const store = createStore();
    const file = {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      content: 'const a = 1;',
      sourceChatId: 'chat-1',
      isWorktreeContext: true,
      isPreview: false,
    };
    store.set(openFilesAtom, [file]);

    store.set(clearPaneContextAtom);

    const next = store.get(openFilesAtom)[0];
    expect(next).toEqual(file);
  });
});

describe('codeEditorMaximizedAtom', () => {
  it('defaults to false', () => {
    const store = createStore();
    expect(store.get(codeEditorMaximizedAtom)).toBe(false);
  });

  it('can be set externally for programmatic maximize', () => {
    const store = createStore();
    store.set(codeEditorMaximizedAtom, true);
    expect(store.get(codeEditorMaximizedAtom)).toBe(true);
  });

  it('is independent of open state at the atom level (component resets on close)', () => {
    const store = createStore();

    store.set(openFileAtom, { path: 'config.json', name: 'config.json', intent: 'pinned' });
    store.set(codeEditorMaximizedAtom, true);
    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(codeEditorMaximizedAtom)).toBe(true);

    store.set(codeEditorOpenAtom, false);

    // Atoms are independent — CodeEditorPanel resets maximized in its close handlers.
    expect(store.get(codeEditorMaximizedAtom)).toBe(true);
  });
});

// sc-3855: closing the panel (✕ or Esc sets codeEditorOpenAtom false, tabs stay) must not stop a
// file-tree click from reopening it.
describe('openFileAtom after the panel is closed', () => {
  it('reopens the panel on the already-open file', () => {
    const store = createStore();
    const file = {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      intent: 'preview' as const,
    };
    store.set(openFileAtom, file);
    store.set(codeEditorOpenAtom, false);

    store.set(openFileAtom, file);

    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(openFilesAtom)).toHaveLength(1);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/a.ts', '/repo'));
  });

  it('reopens the panel on a different file that replaces the preview tab', () => {
    const store = createStore();
    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });
    store.set(codeEditorOpenAtom, false);

    store.set(openFileAtom, { path: 'src/b.ts', name: 'b.ts', projectPath: '/repo' });

    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(openFilesAtom).map((f) => f.path)).toEqual(['src/b.ts']);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/b.ts', '/repo'));
  });

  it('reopens the panel on a new tab alongside a pinned one', () => {
    const store = createStore();
    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      intent: 'pinned',
    });
    store.set(codeEditorOpenAtom, false);

    store.set(openFileAtom, { path: 'src/b.ts', name: 'b.ts', projectPath: '/repo' });

    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(openFilesAtom).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('openFileAtom after the last tab is closed', () => {
  it('closing the last tab closes the panel, and the next open reopens it', () => {
    const store = createStore();
    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });

    store.set(closeFileAtom, fileKey('src/a.ts', '/repo'));
    expect(store.get(codeEditorOpenAtom)).toBe(false);
    expect(store.get(activeFilePathAtom)).toBeNull();

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });

    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(openFilesAtom).map((f) => f.path)).toEqual(['src/a.ts']);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/a.ts', '/repo'));
  });
});

describe('openFileAtom after the panel is closed in split view', () => {
  it('reopens from another pane without replacing the first pane preview tab', () => {
    const store = createStore();
    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      sourcePaneIndex: 0,
    });
    store.set(codeEditorOpenAtom, false);

    store.set(openFileAtom, {
      path: 'src/b.ts',
      name: 'b.ts',
      projectPath: '/repo',
      sourcePaneIndex: 1,
    });

    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(openFilesAtom).map((f) => [f.path, f.sourcePaneIndex])).toEqual([
      ['src/a.ts', 0],
      ['src/b.ts', 1],
    ]);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/b.ts', '/repo'));
  });
});

// An Edit card, the diff list or Settings opens a file from no pane; the filtered bar shows only
// the active pane's tabs, so a file with no pane would open hidden.
describe('openFileAtom in split view', () => {
  const inSplitView = (activePane: number) => {
    const store = createStore();
    store.set(editorIsSplitActiveAtom, true);
    store.set(editorActivePaneIndexAtom, activePane);
    return store;
  };
  const panes = (store: ReturnType<typeof createStore>) =>
    store.get(openFilesAtom).map((f) => [f.path, f.sourcePaneIndex]);

  it('puts a file opened from no pane in the active pane', () => {
    const store = inSplitView(1);

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });

    expect(panes(store)).toEqual([['src/a.ts', 1]]);
  });

  it('keeps the pane a file is opened from', () => {
    const store = inSplitView(1);

    store.set(openFileAtom, {
      path: 'src/a.ts',
      name: 'a.ts',
      projectPath: '/repo',
      sourcePaneIndex: 0,
    });

    expect(panes(store)).toEqual([['src/a.ts', 0]]);
  });

  it('leaves a file opened from no pane in single view out of every pane', () => {
    const store = createStore();
    store.set(editorActivePaneIndexAtom, 1);

    store.set(openFileAtom, { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo' });

    expect(panes(store)).toEqual([['src/a.ts', undefined]]);
  });
});

describe("openFileAtom keeps each project's tabs together", () => {
  const pin = (store: ReturnType<typeof createStore>, path: string, projectPath: string) =>
    store.set(openFileAtom, { path, name: path, projectPath, intent: 'pinned' });
  const bar = (store: ReturnType<typeof createStore>) =>
    arrangeTabsByProject(store.get(openFilesAtom)).order.map((f) => f.path);

  // ros's app.ts was opened first, so ros's group led; closing it must not put qa's group first.
  it('so closing a tab leaves the other tabs where they were', () => {
    const store = createStore();
    pin(store, 'app.ts', '/ros');
    pin(store, 'CONTRIBUTING.md', '/qa');
    pin(store, 'README.md', '/ros');

    store.set(closeFileAtom, fileKey('app.ts', '/ros'));

    expect(bar(store)).toEqual(['README.md', 'CONTRIBUTING.md']);
  });

  it("puts another project's file that replaces a preview tab with that project's tabs", () => {
    const store = createStore();
    store.set(openFileAtom, { path: 'a.ts', name: 'a.ts', projectPath: '/web' });
    pin(store, 'b.ts', '/web');
    pin(store, 'x.ts', '/api');

    store.set(openFileAtom, { path: 'y.ts', name: 'y.ts', projectPath: '/api' });

    expect(bar(store)).toEqual(['b.ts', 'x.ts', 'y.ts']);
  });
});

// Quick open and the Search tab open a file by its full path; the tree names it from its folder.
describe('openFileAtom names a file inside its folder from that folder', () => {
  it.each([
    ['a full path inside the folder', '/repo/src/a.ts', '/repo', 'src/a.ts'],
    ['a Windows full path, keeping its case', 'C:\\Repo\\src\\A.ts', 'c:/repo/', 'src/A.ts'],
    // A folder with a trailing slash joined to a path doubles the slash.
    ['a full path with a doubled slash after the folder', '/repo//src/a.ts', '/repo/', 'src/a.ts'],
    ['a path in a folder whose name starts the same', '/repo-2/a.ts', '/repo', '/repo-2/a.ts'],
    ['a full path opened with no folder', '/repo/src/a.ts', undefined, '/repo/src/a.ts'],
  ])('%s', (_case, path, projectPath, stored) => {
    const store = createStore();

    store.set(openFileAtom, { path, name: 'a.ts', projectPath });

    expect(store.get(openFilesAtom).map((f) => f.path)).toEqual([stored]);
    expect(store.get(activeFilePathAtom)).toBe(fileKey(stored, projectPath));
  });
});
