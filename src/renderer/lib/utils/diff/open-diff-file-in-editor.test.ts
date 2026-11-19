// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedDiffFile } from '../../../../shared/changes-types';
import { parseRenderableDiffFiles } from './diff-code-view-items';
import { openDiffFileInEditor } from './open-diff-file-in-editor';

function renderable(path: string, header: string[], hunk: string[]) {
  const diffText = [
    `diff --git a/${path} b/${path}`,
    ...header,
    `--- a/${path}`,
    header.length ? '+++ /dev/null' : `+++ b/${path}`,
    ...hunk,
    '',
  ].join('\n');
  const file: ParsedDiffFile = {
    key: `${path}->${path}`,
    oldPath: path,
    newPath: path,
    diffText,
    isBinary: false,
    additions: 1,
    deletions: 1,
    isValid: true,
    fileLang: null,
    isNewFile: false,
    isDeletedFile: header.length > 0,
  };
  return parseRenderableDiffFiles([file]).renderable[0];
}

describe('openDiffFileInEditor', () => {
  const reveals: unknown[] = [];
  const listen = (event: Event) => {
    if (event instanceof CustomEvent) reveals.push(event.detail);
  };

  beforeEach(() => {
    reveals.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    window.addEventListener('editor:reveal-line', listen);
  });

  afterEach(() => {
    window.removeEventListener('editor:reveal-line', listen);
    vi.unstubAllGlobals();
  });

  it('opens the file and asks the editor to reveal its first changed line', () => {
    const openFile = vi.fn();
    const file = renderable(
      'src/app.ts',
      [],
      ['@@ -10,4 +10,5 @@', ' a', ' b', '+new', ' c', ' d'],
    );

    openDiffFileInEditor({
      filePath: 'src/app.ts',
      files: [file],
      worktreePath: '/repo/',
      chatId: 'c1',
      openFile,
    });

    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/app.ts' }));
    expect(reveals).toEqual([
      {
        filePath: '/repo/src/app.ts',
        lineNumber: 12,
        startColumn: undefined,
        endColumn: undefined,
      },
    ]);
  });

  it('reveals the changed line of the file whose title was clicked, not another listed file', () => {
    const first = renderable('src/a.ts', [], ['@@ -1,2 +1,3 @@', ' a', '+new', ' b']);
    const second = renderable('src/b.ts', [], ['@@ -20,3 +20,4 @@', ' a', ' b', '+new', ' c']);

    openDiffFileInEditor({
      filePath: 'src/b.ts',
      files: [first, second],
      worktreePath: '/repo',
      chatId: 'c1',
      openFile: vi.fn(),
    });

    expect(reveals).toEqual([
      expect.objectContaining({ filePath: '/repo/src/b.ts', lineNumber: 22 }),
    ]);
  });

  it('opens a deleted file without asking for a reveal', () => {
    const openFile = vi.fn();
    const file = renderable('old.ts', ['deleted file mode 100644'], ['@@ -1,1 +0,0 @@', '-a']);

    openDiffFileInEditor({
      filePath: 'old.ts',
      files: [file],
      worktreePath: '/repo',
      chatId: 'c1',
      openFile,
    });

    expect(openFile).toHaveBeenCalledOnce();
    expect(reveals).toEqual([]);
  });
});
