import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARK_CAP, startUserTimingBound, TRIM_INTERVAL_MS } from './bound-user-timing';

const marksOfLength = (n: number) => Array.from({ length: n }) as PerformanceEntry[];

describe('startUserTimingBound', () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    performance.clearMeasures();
    performance.clearMarks();
  });

  it('clears measures on every tick, not before the first', () => {
    const clearMeasures = vi.spyOn(performance, 'clearMeasures');
    stop = startUserTimingBound();

    vi.advanceTimersByTime(TRIM_INTERVAL_MS - 1);
    expect(clearMeasures).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TRIM_INTERVAL_MS * 2);
    expect(clearMeasures).toHaveBeenCalledTimes(3);
  });

  it('leaves marks alone at exactly the cap and clears them one past it', () => {
    const clearMarks = vi.spyOn(performance, 'clearMarks');
    const byType = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(marksOfLength(MARK_CAP));
    stop = startUserTimingBound();

    vi.advanceTimersByTime(TRIM_INTERVAL_MS);
    expect(byType).toHaveBeenCalledWith('mark');
    expect(clearMarks).not.toHaveBeenCalled();

    byType.mockReturnValue(marksOfLength(MARK_CAP + 1));
    vi.advanceTimersByTime(TRIM_INTERVAL_MS);
    expect(clearMarks).toHaveBeenCalledTimes(1);
  });

  it('empties the real measure buffer, React-style names included, while keeping marks under the cap', () => {
    performance.mark('query:chats.list');
    performance.measure('​ChatListItem', { start: 0, end: 1 });
    performance.measure('​DropdownMenu', { start: 0, end: 1 });
    performance.measure('Reconnect', { start: 0, end: 1 });
    stop = startUserTimingBound();

    vi.advanceTimersByTime(TRIM_INTERVAL_MS);

    expect(performance.getEntriesByType('measure')).toHaveLength(0);
    expect(performance.getEntriesByType('mark').map((e) => e.name)).toEqual(['query:chats.list']);
  });

  it('stops clearing once disposed', () => {
    const clearMeasures = vi.spyOn(performance, 'clearMeasures');
    startUserTimingBound()();

    vi.advanceTimersByTime(TRIM_INTERVAL_MS * 5);
    expect(clearMeasures).not.toHaveBeenCalled();
  });

  it('schedules nothing outside dev builds', () => {
    vi.stubEnv('DEV', false);
    const clearMeasures = vi.spyOn(performance, 'clearMeasures');
    stop = startUserTimingBound();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(TRIM_INTERVAL_MS * 5);
    expect(clearMeasures).not.toHaveBeenCalled();
  });
});
