import { describe, expect, it } from 'vitest';
import { editableQueuedImages } from './queue-utils';

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
