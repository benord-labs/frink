// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  extractDiffLineInfo,
  rectsSemanticallyEqual,
  selectionStateSemanticallyEqual,
  sourcesSemanticallyEqual,
} from './text-selection-context';

describe('rectsSemanticallyEqual', () => {
  it('treats two DOMRect instances with identical geometry as equal (not object identity)', () => {
    const a = new DOMRect(1, 2, 100, 40);
    const b = new DOMRect(1, 2, 100, 40);
    expect(a).not.toBe(b);
    expect(rectsSemanticallyEqual(a, b)).toBe(true);
  });

  it('returns false when x differs', () => {
    expect(rectsSemanticallyEqual(new DOMRect(0, 0, 1, 1), new DOMRect(1, 0, 1, 1))).toBe(false);
  });

  it('treats both null as equal', () => {
    expect(rectsSemanticallyEqual(null, null)).toBe(true);
  });

  it('returns false when one rect is null', () => {
    expect(rectsSemanticallyEqual(new DOMRect(0, 0, 1, 1), null)).toBe(false);
    expect(rectsSemanticallyEqual(null, new DOMRect(0, 0, 1, 1))).toBe(false);
  });
});

describe('sourcesSemanticallyEqual', () => {
  it('treats matching assistant-message sources as equal', () => {
    expect(
      sourcesSemanticallyEqual(
        { type: 'assistant-message', messageId: 'm1' },
        { type: 'assistant-message', messageId: 'm1' },
      ),
    ).toBe(true);
  });

  it('returns false when assistant messageId differs', () => {
    expect(
      sourcesSemanticallyEqual(
        { type: 'assistant-message', messageId: 'a' },
        { type: 'assistant-message', messageId: 'b' },
      ),
    ).toBe(false);
  });

  it('compares diff filePath, lineNumber, and lineType', () => {
    const base = {
      type: 'diff' as const,
      filePath: '/a.ts',
      lineNumber: 3,
      lineType: 'new' as const,
    };
    expect(sourcesSemanticallyEqual(base, { ...base })).toBe(true);
    expect(sourcesSemanticallyEqual(base, { ...base, lineNumber: 4 })).toBe(false);
    expect(sourcesSemanticallyEqual(base, { ...base, lineType: 'old' })).toBe(false);
    expect(sourcesSemanticallyEqual(base, { ...base, filePath: '/b.ts' })).toBe(false);
  });

  it('returns false when source types differ', () => {
    expect(
      sourcesSemanticallyEqual(
        { type: 'assistant-message', messageId: 'x' },
        { type: 'diff', filePath: '/x' },
      ),
    ).toBe(false);
  });

  it('compares tool-edit filePath and isWrite', () => {
    const w = { type: 'tool-edit' as const, filePath: '/f', isWrite: true };
    expect(sourcesSemanticallyEqual(w, { ...w })).toBe(true);
    expect(sourcesSemanticallyEqual(w, { ...w, isWrite: false })).toBe(false);
  });

  it('compares plan planPath', () => {
    const p = { type: 'plan' as const, planPath: '/plan.md' };
    expect(sourcesSemanticallyEqual(p, { ...p })).toBe(true);
    expect(sourcesSemanticallyEqual(p, { ...p, planPath: '/other.md' })).toBe(false);
  });
});

describe('selectionStateSemanticallyEqual', () => {
  const baseState = {
    selectedText: 'hello',
    source: { type: 'assistant-message' as const, messageId: 'm1' },
    selectionRect: new DOMRect(0, 0, 10, 10),
  };

  it('treats identical logical state as equal when DOMRect is a new instance', () => {
    const a = { ...baseState, selectionRect: new DOMRect(0, 0, 10, 10) };
    const b = { ...baseState, selectionRect: new DOMRect(0, 0, 10, 10) };
    expect(a.selectionRect).not.toBe(b.selectionRect);
    expect(selectionStateSemanticallyEqual(a, b)).toBe(true);
  });

  it('returns false when selectedText changes', () => {
    expect(
      selectionStateSemanticallyEqual(baseState, { ...baseState, selectedText: 'other' }),
    ).toBe(false);
  });

  it('returns false when source changes', () => {
    expect(
      selectionStateSemanticallyEqual(baseState, {
        ...baseState,
        source: { type: 'assistant-message', messageId: 'm2' },
      }),
    ).toBe(false);
  });
});

describe('extractDiffLineInfo', () => {
  it('reads explicit new line attribute from row', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<table><tr data-line-new="42"><td><span id="target">x</span></td></tr></table>`;
    const target = wrapper.querySelector('#target');
    if (!target) throw new Error('target not found');

    expect(extractDiffLineInfo(target)).toEqual({ lineNumber: 42, lineType: 'new' });
  });

  it('reads explicit old line attribute from row', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<table><tr data-line-old="7"><td><span id="target">x</span></td></tr></table>`;
    const target = wrapper.querySelector('#target');
    if (!target) throw new Error('target not found');

    expect(extractDiffLineInfo(target)).toEqual({ lineNumber: 7, lineType: 'old' });
  });

  it('falls back to table numeric cells when data attributes are absent', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <table>
        <tr>
          <td class="line-old-num" id="old-cell">12</td>
          <td class="line-new-num" id="new-cell">14</td>
          <td><span id="target">line content</span></td>
        </tr>
      </table>
    `;
    const target = wrapper.querySelector('#target');
    if (!target) throw new Error('target not found');

    expect(extractDiffLineInfo(target)).toEqual({ lineNumber: 14, lineType: 'new' });
  });
});
