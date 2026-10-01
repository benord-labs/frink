// @vitest-environment happy-dom
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePasteEvent } from './paste-text';

const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn() }));
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }));

function editable(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  document.body.appendChild(el);
  return el;
}

function placeCaret(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function pasteEvent(text: string, target: HTMLElement) {
  const preventDefault = vi.fn();
  const event = {
    preventDefault,
    currentTarget: target,
    clipboardData: { items: [], getData: (type: string) => (type === 'text/plain' ? text : '') },
  } as unknown as React.ClipboardEvent;
  return { event, preventDefault };
}

describe('handlePasteEvent', () => {
  let input: HTMLDivElement;

  beforeEach(() => {
    toastWarning.mockReset();
    document.body.innerHTML = '';
    input = editable();
    placeCaret(input);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('inserts a paste of exactly the 5,000-char threshold inline', () => {
    const add = vi.fn(async () => {});
    const { event } = pasteEvent('a'.repeat(5000), input);

    handlePasteEvent(event, vi.fn(), add);

    expect(add).not.toHaveBeenCalled();
    expect(input.textContent).toHaveLength(5000);
  });

  it('routes a 5,001-char paste to a file chip and inserts nothing inline', async () => {
    const add = vi.fn(async () => {});
    const { event } = pasteEvent('a'.repeat(5001), input);

    handlePasteEvent(event, vi.fn(), add);
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));

    expect(input.textContent).toBe('');
  });

  // sc-3666: the paste was preventDefault'ed and the write failure swallowed, so a large paste
  // vanished with no chip, no text and no message.
  it('falls back to an inline insert with a warning when the file write fails', async () => {
    const add = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const text = 'b'.repeat(6000);
    const { event, preventDefault } = pasteEvent(text, input);

    handlePasteEvent(event, vi.fn(), add);

    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(input.textContent).toBe(text));
    expect(toastWarning).toHaveBeenCalled();
  });

  it('inserts the fallback into the pasted-into input even if focus moved during the write', async () => {
    let fail!: (err: Error) => void;
    const add = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const other = editable();
    const { event } = pasteEvent('c'.repeat(6000), input);

    handlePasteEvent(event, vi.fn(), add);
    placeCaret(other);
    fail(new Error('disk full'));

    await vi.waitFor(() => expect(input.textContent).toHaveLength(6000));
    expect(other.textContent).toBe('');
  });

  it('truncates a failed >10k paste to the inline cap instead of freezing the editor', async () => {
    const add = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const { event } = pasteEvent('d'.repeat(25_000), input);

    handlePasteEvent(event, vi.fn(), add);

    await vi.waitFor(() => expect(input.textContent).toHaveLength(10_000));
  });
});
