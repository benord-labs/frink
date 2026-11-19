// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fileKey, type OpenFile } from '@/lib/code-editor/state';
import { arrangeTabsByProject } from '@/lib/code-editor/tabs';
import { useEditorWindowShortcuts } from './use-editor-window-shortcuts';

const tab = (path: string, projectPath: string): OpenFile => ({ path, name: path, projectPath });
const keyOf = (file: OpenFile) => fileKey(file.path, file.projectPath);

describe('useEditorWindowShortcuts', () => {
  // Opened a.ts from web, then x.ts from api, then b.ts from web: the bar reads [web a b][api x].
  it('cycles through tabs from two projects in the order the tab bar draws them', () => {
    const [a, x, b] = [
      tab('src/a.ts', '/work/web'),
      tab('src/x.ts', '/work/api'),
      tab('src/b.ts', '/work/web'),
    ];
    const setActivePath = vi.fn<(key: string) => void>();
    const { rerender } = renderHook(
      ({ activePath }) =>
        useEditorWindowShortcuts({
          visibleFiles: arrangeTabsByProject([a, x, b]).order,
          activePath,
          setActivePath,
          editorRef: { current: null },
          isOpen: true,
        }),
      { initialProps: { activePath: keyOf(a) } },
    );
    const cycle = (direction: 1 | -1) => {
      window.dispatchEvent(new CustomEvent('editor:cycle-pane-group', { detail: direction }));
      const next = setActivePath.mock.lastCall?.[0] ?? '';
      rerender({ activePath: next });
      return next;
    };

    expect([cycle(1), cycle(1), cycle(1)]).toEqual([keyOf(b), keyOf(x), keyOf(a)]);
    expect(cycle(-1)).toBe(keyOf(x));
  });
});
