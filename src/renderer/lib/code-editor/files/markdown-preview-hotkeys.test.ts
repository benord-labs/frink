import { describe, expect, it } from 'vitest';
import { isMarkdownPreviewToggleShortcut } from './markdown-preview-hotkeys';

const base = {
  key: 'v',
  code: 'KeyV',
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: true,
  isEditorOpen: true,
  inPanel: true,
  filePath: 'docs/README.md',
} as const;

describe('isMarkdownPreviewToggleShortcut', () => {
  it('returns true for Cmd+Alt+V when panel is open and file is markdown', () => {
    expect(isMarkdownPreviewToggleShortcut({ ...base })).toBe(true);
    expect(
      isMarkdownPreviewToggleShortcut({
        ...base,
        metaKey: false,
        ctrlKey: true,
      }),
    ).toBe(true);
    expect(
      isMarkdownPreviewToggleShortcut({
        ...base,
        filePath: 'post.MDX',
      }),
    ).toBe(true);
  });

  it('returns false when Shift is held (avoid ambiguous modified-V chords)', () => {
    expect(isMarkdownPreviewToggleShortcut({ ...base, shiftKey: true })).toBe(false);
  });

  it('returns false when Alt is not held', () => {
    expect(isMarkdownPreviewToggleShortcut({ ...base, altKey: false })).toBe(false);
  });

  it('returns false when editor is closed, focus outside panel, or file is not markdown', () => {
    expect(isMarkdownPreviewToggleShortcut({ ...base, isEditorOpen: false })).toBe(false);
    expect(isMarkdownPreviewToggleShortcut({ ...base, inPanel: false })).toBe(false);
    expect(isMarkdownPreviewToggleShortcut({ ...base, filePath: 'src/index.ts' })).toBe(false);
    expect(isMarkdownPreviewToggleShortcut({ ...base, filePath: undefined })).toBe(false);
  });

  it('returns false without Cmd/Ctrl', () => {
    expect(
      isMarkdownPreviewToggleShortcut({
        ...base,
        metaKey: false,
        ctrlKey: false,
      }),
    ).toBe(false);
  });

  it('matches KeyV when key is uppercase V', () => {
    expect(
      isMarkdownPreviewToggleShortcut({
        ...base,
        key: 'V',
        code: 'KeyV',
      }),
    ).toBe(true);
  });
});
