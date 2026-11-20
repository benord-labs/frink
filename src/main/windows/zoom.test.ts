import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { keepAppZoom } from './zoom';

describe('keepAppZoom', () => {
  it('applies the app zoom at once and again after every in-page navigation', () => {
    const contents = Object.assign(new EventEmitter(), { setZoomFactor: vi.fn() });
    let zoom = 0.9;
    keepAppZoom(contents, () => zoom);

    contents.emit('did-navigate-in-page');
    zoom = 1.1;
    contents.emit('did-navigate-in-page');

    expect(contents.setZoomFactor.mock.calls).toEqual([[0.9], [0.9], [1.1]]);
  });
});
