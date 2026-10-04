import { describe, expect, it } from 'vitest';
import {
  createQueueItem,
  editableQueuedImages,
  FLOW_DISPATCH_SOURCE,
  isDispatchQueueItem,
  queueItemToSendMessage,
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

describe('queueItemToSendMessage', () => {
  const image = { id: 'i', url: 'blob:live', mediaType: 'image/png', filename: 'a.png' };
  const file = {
    id: 'f',
    url: 'blob:file',
    filename: 'notes.txt',
    mediaType: 'text/plain',
    size: 3,
  };

  it('carries images, files and text in that order, with no metadata for a typed message', () => {
    const { message, sendable } = queueItemToSendMessage(
      createQueueItem('q', 'look at these', [image], [file]),
    );

    expect(sendable).toBe(true);
    expect(message).toEqual({
      role: 'user',
      parts: [
        {
          type: 'data-image',
          data: {
            url: 'blob:live',
            mediaType: 'image/png',
            filename: 'a.png',
            base64Data: undefined,
          },
        },
        {
          type: 'data-file',
          data: { url: 'blob:file', mediaType: 'text/plain', filename: 'notes.txt', size: 3 },
        },
        { type: 'text', text: 'look at these' },
      ],
    });
    expect(message).not.toHaveProperty('metadata');
  });

  it('keeps an image that has inline data but no url, and drops one with neither', () => {
    const { message, sendable } = queueItemToSendMessage(
      createQueueItem('q', '', [
        { id: 'inline', url: '', mediaType: 'image/png', base64Data: 'QUJD' },
        { id: 'dead', url: '', mediaType: 'image/png' },
      ]),
    );

    expect(sendable).toBe(true);
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({ type: 'data-image', data: { base64Data: 'QUJD' } });
  });

  it('serializes attached contexts into the text part, so a context-only item is sendable', () => {
    const { message, sendable } = queueItemToSendMessage(
      createQueueItem('q', '', undefined, undefined, [
        { id: 't', text: 'quoted words', sourceMessageId: 'm' },
      ]),
    );

    expect(sendable).toBe(true);
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(message.parts[0])).toContain('@[quote:');
  });

  it('forwards the dispatch source and task id as metadata', () => {
    const { message } = queueItemToSendMessage({
      ...createQueueItem('q', 'flow prompt'),
      source: FLOW_DISPATCH_SOURCE,
      dispatchTaskId: 'task-1',
    });

    expect(message.metadata).toEqual({ source: 'flow-dispatch', dispatchTaskId: 'task-1' });
  });

  it('forwards a task id on its own when the dispatch is not a flow prompt', () => {
    const { message } = queueItemToSendMessage({
      ...createQueueItem('q', 'task prompt'),
      dispatchTaskId: 'task-1',
    });

    expect(message.metadata).toEqual({ dispatchTaskId: 'task-1' });
  });

  it('is not sendable when the message is only whitespace', () => {
    const { message, sendable } = queueItemToSendMessage(createQueueItem('q', '   \n'));

    expect(sendable).toBe(false);
    expect(message.parts).toEqual([]);
  });

  it('is not sendable when its only image has a url but no inline data to forward', () => {
    const { message, sendable } = queueItemToSendMessage(
      createQueueItem('q', '', [{ id: 'i', url: 'blob:live', mediaType: 'image/png' }]),
    );

    expect(sendable).toBe(false);
    expect(message.parts).toHaveLength(1);
  });

  it('stays sendable with text when an image has no inline data, keeping the image part', () => {
    const { message, sendable } = queueItemToSendMessage(
      createQueueItem('q', 'look', [{ id: 'i', url: 'blob:live', mediaType: 'image/png' }]),
    );

    expect(sendable).toBe(true);
    expect(message.parts.map((p) => p.type)).toEqual(['data-image', 'text']);
  });

  it('is not sendable with files alone, which carry nothing to the agent', () => {
    const { message, sendable } = queueItemToSendMessage(
      createQueueItem('q', '', undefined, [file]),
    );

    expect(sendable).toBe(false);
    expect(message.parts).toHaveLength(1);
  });
});

describe('isDispatchQueueItem', () => {
  it('is true for a flow prompt or a task dispatch, false for a typed message', () => {
    const typed = createQueueItem('q', 'hi');

    expect(isDispatchQueueItem(typed)).toBe(false);
    expect(isDispatchQueueItem({ ...typed, source: FLOW_DISPATCH_SOURCE })).toBe(true);
    expect(isDispatchQueueItem({ ...typed, dispatchTaskId: 'task-1' })).toBe(true);
  });

  it('agrees with the builder: an empty task id is neither dispatch metadata nor a dispatch item', () => {
    const item = { ...createQueueItem('q', 'hi'), dispatchTaskId: '' };

    expect(queueItemToSendMessage(item).message).not.toHaveProperty('metadata');
    expect(isDispatchQueueItem(item)).toBe(false);
  });
});
