import { describe, expect, it } from 'vitest';
import {
  createQueueItem,
  editableQueuedImages,
  FLOW_DISPATCH_SOURCE,
  queuedSendMetadata,
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
    const withPaste = createQueueItem('q1', '', undefined, undefined, undefined, undefined, [
      pasted,
    ]);
    const without = createQueueItem('q2', 'hi', undefined, undefined, undefined, undefined, []);

    expect(withPaste.pastedTexts).toEqual([pasted]);
    expect(without.pastedTexts).toBeUndefined();
  });

  it('strips composer-only fields when queueing a chip', () => {
    const chip = { ...pasted, createdAt: new Date(0) };
    expect(toQueuedPastedText(chip)).toEqual(pasted);
  });
});

describe('queuedSendMetadata', () => {
  it('carries the source and task id of a dispatched item', () => {
    const item = {
      ...createQueueItem('q', 'flow prompt'),
      source: FLOW_DISPATCH_SOURCE,
      dispatchTaskId: 't1',
    };

    expect(queuedSendMetadata(item)).toEqual({
      metadata: { source: 'flow-dispatch', dispatchTaskId: 't1' },
    });
  });

  it('carries a task id alone for a non-headless dispatch', () => {
    const item = { ...createQueueItem('q', 'task prompt'), dispatchTaskId: 't1' };

    expect(queuedSendMetadata(item)).toEqual({ metadata: { dispatchTaskId: 't1' } });
  });

  it('adds no metadata key for a typed message', () => {
    expect(queuedSendMetadata(createQueueItem('q', 'hi'))).toEqual({});
  });
});
