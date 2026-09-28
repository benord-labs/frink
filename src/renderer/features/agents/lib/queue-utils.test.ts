import { describe, expect, it } from 'vitest';
import { createQueueItem, toQueuedPastedText } from './queue-utils';

const pasted = {
  id: 'p',
  filePath: '/s/pasted/p.txt',
  filename: 'p.txt',
  size: 6000,
  preview: 'x',
};

describe('queued pasted texts (sc-3666)', () => {
  it('keeps pasted texts on the queue item and drops an empty list to undefined', () => {
    const withPaste = createQueueItem(
      'q1',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [pasted],
    );
    const without = createQueueItem(
      'q2',
      'hi',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(withPaste.pastedTexts).toEqual([pasted]);
    expect(without.pastedTexts).toBeUndefined();
  });

  it('strips composer-only fields when queueing a chip', () => {
    const chip = { ...pasted, createdAt: new Date(0) };
    expect(toQueuedPastedText(chip)).toEqual(pasted);
  });
});
