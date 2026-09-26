/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTextareaCaretViewportPosition } from './get-textarea-caret-viewport';

describe('getTextareaCaretViewportPosition', () => {
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    textarea = document.createElement('textarea');
    textarea.style.width = '200px';
    textarea.style.height = '120px';
    textarea.style.fontSize = '14px';
    textarea.style.lineHeight = '1.25';
    textarea.style.fontFamily = 'monospace';
    textarea.value = 'hello world';
    document.body.appendChild(textarea);
  });

  afterEach(() => {
    textarea?.remove();
  });

  it('returns finite viewport coordinates at caret start and end', () => {
    const start = getTextareaCaretViewportPosition(textarea, 0);
    const end = getTextareaCaretViewportPosition(textarea, textarea.value.length);
    for (const p of [start, end]) {
      expect(Number.isFinite(p.top)).toBe(true);
      expect(Number.isFinite(p.left)).toBe(true);
    }
  });

  it('clamps index past string length to end position', () => {
    const atEnd = getTextareaCaretViewportPosition(textarea, textarea.value.length);
    const clamped = getTextareaCaretViewportPosition(textarea, 99_999);
    expect(clamped).toEqual(atEnd);
  });

  it('clamps negative index to start position', () => {
    const atStart = getTextareaCaretViewportPosition(textarea, 0);
    const clamped = getTextareaCaretViewportPosition(textarea, -10);
    expect(clamped).toEqual(atStart);
  });

  it('handles empty value at index 0', () => {
    textarea.value = '';
    const p = getTextareaCaretViewportPosition(textarea, 0);
    expect(Number.isFinite(p.top)).toBe(true);
    expect(Number.isFinite(p.left)).toBe(true);
  });
});
