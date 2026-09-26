// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFrameCoalesced } from './use-frame-coalesced';

let frames: FrameRequestCallback[] = [];
const runFrame = () => act(() => frames.splice(0).forEach((callback) => callback(0)));

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('useFrameCoalesced', () => {
  it('delivers only the latest value, once per frame', () => {
    const onValue = vi.fn();
    const { result } = renderHook(() => useFrameCoalesced(onValue));
    result.current.push('#111111');
    result.current.push('#222222');
    expect(onValue).not.toHaveBeenCalled();

    runFrame();
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledWith('#222222');
  });

  it('flushes a pending value at once, and on unmount', () => {
    const onValue = vi.fn();
    const { result, unmount } = renderHook(() => useFrameCoalesced(onValue));
    result.current.push('#111111');
    result.current.flush();
    expect(onValue).toHaveBeenLastCalledWith('#111111');

    result.current.push('#333333');
    unmount();
    expect(onValue).toHaveBeenLastCalledWith('#333333');
    runFrame();
    expect(onValue).toHaveBeenCalledTimes(2);
  });
});
