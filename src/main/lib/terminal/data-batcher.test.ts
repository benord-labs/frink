import { describe, expect, it, vi } from 'vitest';
import { DataBatcher } from './data-batcher';

const BATCH_MAX_SIZE = 200 * 1024;

describe('DataBatcher', () => {
  it('write after dispose is ignored (no buffer, no onFlush)', () => {
    const onFlush = vi.fn();
    const b = new DataBatcher(onFlush);
    b.dispose();
    b.write('late');
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('flush when buffer reaches BATCH_MAX_SIZE without waiting for timer', () => {
    const onFlush = vi.fn();
    const b = new DataBatcher(onFlush);
    b.write('x'.repeat(BATCH_MAX_SIZE));
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toHaveLength(BATCH_MAX_SIZE);
    onFlush.mockClear();
    b.write('tail');
    b.dispose();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toBe('tail');
  });

  it('timer flush fires after BATCH_DURATION_MS', () => {
    vi.useFakeTimers();
    try {
      const onFlush = vi.fn();
      const b = new DataBatcher(onFlush);
      b.write('tick');
      expect(onFlush).not.toHaveBeenCalled();
      vi.advanceTimersByTime(16);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0]?.[0]).toBe('tick');
      b.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose uses decoder.end() for incomplete UTF-8 tail (replacement char)', () => {
    const onFlush = vi.fn();
    const b = new DataBatcher(onFlush);
    b.write(Buffer.from([0xe2]));
    b.dispose();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toBe('\uFFFD');
  });

  it('dispose is idempotent: second dispose does not invoke onFlush again', () => {
    const onFlush = vi.fn();
    const b = new DataBatcher(onFlush);
    b.write('hello');
    b.dispose();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toBe('hello');
    onFlush.mockClear();
    b.dispose();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('flush then dispose does not re-flush the same buffer', () => {
    const onFlush = vi.fn();
    const b = new DataBatcher(onFlush);
    b.write('a');
    b.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toBe('a');
    onFlush.mockClear();
    b.dispose();
    expect(onFlush).not.toHaveBeenCalled();
  });
});
