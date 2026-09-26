import { describe, expect, it } from 'vitest';
import { buildInlineDiffLayout } from './inline-diff-layout';

describe('buildInlineDiffLayout', () => {
  it('returns empty layout when contents match', () => {
    const layout = buildInlineDiffLayout('const a = 1;\n', 'const a = 1;\n');
    expect(layout).toEqual({
      lineDecorations: [],
      tokenDecorations: [],
      deletedBlocks: [],
      hasChanges: false,
    });
  });

  it('marks added lines', () => {
    const layout = buildInlineDiffLayout('a\nb\n', 'a\nx\nb\n');
    expect(layout.lineDecorations).toContainEqual({
      type: 'added',
      startLine: 2,
      endLine: 2,
    });
    expect(layout.hasChanges).toBe(true);
  });

  it('treats brand-new files as all added lines', () => {
    const layout = buildInlineDiffLayout('', 'line 1\nline 2\nline 3\n');
    expect(layout.lineDecorations).toEqual([{ type: 'added', startLine: 1, endLine: 3 }]);
    expect(layout.tokenDecorations).toEqual([]);
    expect(layout.deletedBlocks).toEqual([]);
    expect(layout.hasChanges).toBe(true);
  });

  it('creates deleted blocks for removed lines', () => {
    const layout = buildInlineDiffLayout('a\nx\nb\n', 'a\nb\n');
    expect(layout.deletedBlocks).toContainEqual({
      afterLineNumber: 1,
      lines: ['x'],
    });
    expect(layout.hasChanges).toBe(true);
  });

  it('marks modified lines with token ranges and emits old content as deleted block', () => {
    const layout = buildInlineDiffLayout('const value = 1;\n', 'const value = 42;\n');
    expect(layout.lineDecorations).toContainEqual({
      type: 'modified',
      startLine: 1,
      endLine: 1,
    });
    expect(layout.tokenDecorations.some((t) => t.lineNumber === 1)).toBe(true);
    expect(layout.deletedBlocks).toContainEqual({
      afterLineNumber: 0,
      lines: ['const value = 1;'],
    });
    expect(layout.hasChanges).toBe(true);
  });

  it('handles mixed modifications and trailing deletions in one hunk', () => {
    const layout = buildInlineDiffLayout(
      'start\nalpha\nbeta\ngamma\nend\n',
      'start\nalpha-updated\nend\n',
    );
    expect(layout.lineDecorations).toContainEqual({
      type: 'modified',
      startLine: 2,
      endLine: 2,
    });
    expect(layout.deletedBlocks).toContainEqual({
      afterLineNumber: 2,
      lines: ['beta', 'gamma'],
    });
    expect(layout.hasChanges).toBe(true);
  });

  it('collapses large full-file additions into a single line decoration range', () => {
    const largeAdded = `${Array.from({ length: 10000 }, (_, idx) => `line-${idx + 1}`).join('\n')}\n`;
    const layout = buildInlineDiffLayout('', largeAdded);
    expect(layout.lineDecorations).toEqual([{ type: 'added', startLine: 1, endLine: 10000 }]);
    expect(layout.deletedBlocks).toEqual([]);
    expect(layout.hasChanges).toBe(true);
  });
});
