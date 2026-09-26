// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isXtermTextareaFocused } from './is-xterm-textarea-focused';

describe('isXtermTextareaFocused', () => {
  it('returns true when activeElement is the textarea', () => {
    const ta = document.createElement('textarea');
    expect(isXtermTextareaFocused(ta, ta)).toBe(true);
  });

  it('returns true when activeElement is inside the root subtree (contains branch)', () => {
    const container = document.createElement('div');
    const inner = document.createElement('span');
    container.appendChild(inner);
    // Implementation only uses Element#contains; cast matches the typed API (real xterm passes a textarea).
    expect(isXtermTextareaFocused(container as unknown as HTMLTextAreaElement, inner)).toBe(true);
  });

  it('returns false when textarea is null or undefined', () => {
    const body = document.body;
    expect(isXtermTextareaFocused(null, body)).toBe(false);
    expect(isXtermTextareaFocused(undefined, body)).toBe(false);
  });

  it('returns false when activeElement is null', () => {
    const ta = document.createElement('textarea');
    expect(isXtermTextareaFocused(ta, null)).toBe(false);
  });

  it('returns false when focus is elsewhere', () => {
    const ta = document.createElement('textarea');
    expect(isXtermTextareaFocused(ta, document.body)).toBe(false);
  });
});
