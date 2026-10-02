import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
  activeFilePathAtom,
  clearPaneContextAtom,
  closeFileAtom,
  closeFilesOutsideProjectAtom,
  codeEditorMaximizedAtom,
  codeEditorOpenAtom,
  fileKey,
  markFileSavedAtom,
  openFileAtom,
  openFilesAtom,
  tagOpenFilesWithPaneContextAtom,
  updateFileContentAtom,
} from './atoms';

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

    const files = store.get(openFilesAtom);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('/repo/worktree/src/a.ts');
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
