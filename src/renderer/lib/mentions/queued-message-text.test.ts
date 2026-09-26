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
});
