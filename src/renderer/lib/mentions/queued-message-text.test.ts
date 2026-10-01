import { describe, expect, it } from 'vitest';
import { buildQueuedMessageText } from './queued-message-text';

type Item = Parameters<typeof buildQueuedMessageText>[0];
const item = (over: Partial<Item>): Item => ({ message: 'do the thing', ...over });

describe('buildQueuedMessageText', () => {
  it('prefixes a normal queued message with its quote and diff mentions', () => {
    const text = buildQueuedMessageText(
      item({
        textContexts: [{ text: 'quoted source' }],
        diffTextContexts: [{ text: 'diff body', filePath: 'a.ts', lineNumber: 7 }],
      }),
    );

    expect(text.endsWith('do the thing')).toBe(true);
    expect(text).toContain('@[');
    expect(text.startsWith('@[')).toBe(true);
  });

  it('leaves a queued /compact at position 0 despite attached context', () => {
    const text = buildQueuedMessageText(
      item({
        message: '/compact',
        textContexts: [{ text: 'quoted source' }],
        diffTextContexts: [{ text: 'diff body', filePath: 'a.ts', lineNumber: 7 }],
      }),
    );

    expect(text).toBe('/compact');
  });

  it('returns the bare message when no context is attached', () => {
    expect(buildQueuedMessageText(item({}))).toBe('do the thing');
  });

  it('returns an empty string for an empty message with no context', () => {
    // The caller pushes a text part only when this is non-empty; an images-only queue item
    // must not gain a stray blank text part.
    expect(buildQueuedMessageText(item({ message: '' }))).toBe('');
  });

  it('serializes a pasted-text chip so a queued paste is not dropped (sc-3666)', () => {
    const text = buildQueuedMessageText(
      item({
        message: '',
        pastedTexts: [
          { size: 6000, preview: 'Build a [cron] flow...', filePath: '/s/pasted/p_1.txt' },
        ],
      }),
    );

    // Brackets are stripped so the token cannot terminate early; `|` separates the path.
    expect(text).toBe('@[pasted:6000:Build a cron flow...|/s/pasted/p_1.txt]');
  });

  it('keeps a path that contains colons intact after the | separator', () => {
    const text = buildQueuedMessageText(
      item({ pastedTexts: [{ size: 1, preview: 'p', filePath: 'C:\\Users\\a\\pasted\\x.txt' }] }),
    );

    expect(text).toBe('@[pasted:1:p|C:\\Users\\a\\pasted\\x.txt] do the thing');
  });

  it('serializes a code selection in the direct-send token shape', () => {
    const text = buildQueuedMessageText(
      item({
        codeSelectionContexts: [
          { text: 'const ü = 1;', fileName: 'a b.ts', startLine: 3, endLine: 4 },
        ],
      }),
    );

    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode('const ü = 1;')));
    expect(text).toBe(`@[code:a%20b.ts:3-4:const ü = 1;:${encoded}] do the thing`);
  });

  it('orders quote, diff, code, pasted mentions exactly once ahead of the message', () => {
    const text = buildQueuedMessageText(
      item({
        textContexts: [{ text: 'q' }],
        diffTextContexts: [{ text: 'd', filePath: 'a.ts', lineNumber: 1 }],
        codeSelectionContexts: [{ text: 'c', fileName: 'b.ts', startLine: 1, endLine: 1 }],
        pastedTexts: [{ size: 9, preview: 'p', filePath: '/p.txt' }],
      }),
    );

    const order = ['@[quote:', '@[diff:', '@[code:', '@[pasted:', 'do the thing'].map((t) =>
      text.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.match(/@\[pasted:/g)).toHaveLength(1);
  });

  it('still leaves /compact bare when a pasted chip is attached', () => {
    expect(
      buildQueuedMessageText(
        item({ message: '/compact', pastedTexts: [{ size: 1, preview: 'p', filePath: '/p' }] }),
      ),
    ).toBe('/compact');
  });
});
