import { describe, expect, it } from 'vitest';
import {
  type AgentQueueItem,
  createQueueItem,
  dispatchMetadata,
  editableQueuedImages,
  isSupersededDispatch,
  toQueuedPastedText,
} from './queue-utils';

describe('editableQueuedImages', () => {
  it('keeps a live preview url untouched', () => {
    const img = { id: 'i', url: 'blob:live', mediaType: 'image/png', base64Data: 'AAAA' };

    expect(editableQueuedImages([img])).toEqual([img]);
  });

  it('previews a reload-restored image from its inline data', () => {
    const [img] = editableQueuedImages([
      { id: 'i', url: '', mediaType: 'image/jpeg', base64Data: 'QUJD' },
    ]);

    expect(img?.url).toBe('data:image/jpeg;base64,QUJD');
    expect(img?.base64Data).toBe('QUJD');
  });

  it('drops an image with neither a url nor inline data', () => {
    expect(editableQueuedImages([{ id: 'i', url: '', mediaType: 'image/png' }])).toEqual([]);
  });

  it('handles a turn with no images', () => {
    expect(editableQueuedImages(undefined)).toEqual([]);
  });
});

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

describe('isSupersededDispatch (sc-2775)', () => {
  const item = (id: string, dispatchTaskId?: string, dispatchGeneration?: string) =>
    ({
      ...createQueueItem(id, 'Ship the PR'),
      dispatchTaskId,
      dispatchGeneration,
    }) as AgentQueueItem;

  const OLD = '2026-10-02T10:30:13.000Z';
  const NEW = '2026-10-02T10:40:13.000Z';

  it('marks an attempt superseded once a newer attempt of its task is queued', () => {
    expect(isSupersededDispatch(item('a', 't', OLD), [item('b', 't', NEW)])).toBe(true);
  });

  // The current attempt failing to send must never be dropped for an older, delayed one.
  it('never lets a malformed restored generation count as newer', () => {
    expect(isSupersededDispatch(item('a', 't', NEW), [item('b', 't', 'z')])).toBe(false);
    expect(isSupersededDispatch(item('a', 't', 'z'), [item('b', 't', NEW)])).toBe(false);
  });

  it('never marks the current attempt superseded by an older one', () => {
    expect(isSupersededDispatch(item('b', 't', NEW), [item('a', 't', OLD)])).toBe(false);
  });

  it('never marks a user item, another task, or the same attempt', () => {
    expect(isSupersededDispatch(item('a'), [item('b', 't', 'gen-b')])).toBe(false);
    expect(isSupersededDispatch(item('a', 't', 'gen-a'), [item('b', 'u', 'gen-b')])).toBe(false);
    expect(isSupersededDispatch(item('a', 't', 'gen-a'), [item('a', 't', 'gen-a')])).toBe(false);
  });
});

describe('dispatchMetadata (sc-2775)', () => {
  it('drops a non-string generation restored from storage instead of sending it', () => {
    const restored = { dispatchTaskId: 't', dispatchGeneration: 7 } as unknown as AgentQueueItem;
    expect(dispatchMetadata(restored)).toEqual({ dispatchTaskId: 't' });
  });
});
