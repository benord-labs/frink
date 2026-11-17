import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATTERY_POLL_MS,
  createKeepAwake,
  type KeepAwakeDeps,
  parseBatteryPercent,
  RELEASE_DELAY_MS,
} from './keep-awake';
import {
  _resetWorkActivityForTests,
  isWorkActive,
  onWorkChange,
  reportWork,
} from './work-activity';

/** What the fake Mac reports to keep-awake; tests flip these between steps. */
type FakeMac = { working: boolean; enabled: boolean; onBattery: boolean; percent: number | null };

function setup(overrides: Partial<KeepAwakeDeps> = {}) {
  const state: FakeMac = { working: false, enabled: true, onBattery: false, percent: 80 };
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
  const readBatteryPercent = vi.fn(async () => state.percent);
  const keepAwake = createKeepAwake({
    blocker,
    isWorking: () => state.working,
    isEnabled: () => state.enabled,
    isOnBattery: () => state.onBattery,
    readBatteryPercent,
    ...overrides,
  });
  return { state, blocker, readBatteryPercent, keepAwake };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('keep awake', () => {
  it('starts one blocker when work begins, however often it is recomputed', () => {
    const { state, blocker, keepAwake } = setup();
    state.working = true;
    keepAwake.recompute();
    keepAwake.recompute();
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(keepAwake.isHeld()).toBe(true);
  });

  it('releases only after the work has been idle for the whole delay', () => {
    const { state, blocker, keepAwake } = setup();
    state.working = true;
    keepAwake.recompute();
    state.working = false;
    keepAwake.recompute();

    vi.advanceTimersByTime(RELEASE_DELAY_MS - 1);
    expect(blocker.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(keepAwake.isHeld()).toBe(false);
  });

  it('keeps holding when work resumes inside the delay (turn → background wait handoff)', () => {
    const { state, blocker, keepAwake } = setup();
    state.working = true;
    keepAwake.recompute();
    state.working = false;
    keepAwake.recompute();
    vi.advanceTimersByTime(RELEASE_DELAY_MS / 2);
    state.working = true;
    keepAwake.recompute();

    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);
    expect(blocker.stop).not.toHaveBeenCalled();
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });

  it('never starts while the setting is off, and follows it immediately mid-run', () => {
    const { state, blocker, keepAwake } = setup();
    state.enabled = false;
    state.working = true;
    keepAwake.recompute();
    expect(blocker.start).not.toHaveBeenCalled();

    state.enabled = true;
    keepAwake.recompute();
    expect(keepAwake.isHeld()).toBe(true);

    state.enabled = false;
    keepAwake.recompute();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(keepAwake.isHeld()).toBe(false);
  });

  it('lets the Mac sleep below 10% on battery and only takes the hold back on the charger', async () => {
    const { state, blocker, keepAwake } = setup();
    state.onBattery = true;
    state.percent = 9;
    state.working = true;
    keepAwake.recompute();
    await vi.advanceTimersByTimeAsync(0);
    expect(keepAwake.isHeld()).toBe(false);
    expect(blocker.stop).toHaveBeenCalledTimes(1);

    state.percent = 15;
    keepAwake.onBattery();
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(keepAwake.isHeld()).toBe(false);

    state.onBattery = false;
    keepAwake.onAc();
    expect(keepAwake.isHeld()).toBe(true);
  });

  it('never locks from a low reading that lands after the charger was connected', async () => {
    // pmset is slow; a lock set while on AC would stick, since no further on-ac event arrives.
    let resolveRead: (percent: number) => void = () => {};
    const { state, keepAwake } = setup({
      readBatteryPercent: () => new Promise<number>((resolve) => (resolveRead = resolve)),
    });
    state.onBattery = true;
    state.working = true;
    keepAwake.recompute();

    state.onBattery = false;
    keepAwake.onAc();
    resolveRead(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(keepAwake.isHeld()).toBe(true);
  });

  it('keeps holding when the battery read fails', async () => {
    const { state, keepAwake } = setup({
      readBatteryPercent: () => Promise.reject(new Error('pmset timed out')),
    });
    state.onBattery = true;
    state.working = true;
    keepAwake.recompute();
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(keepAwake.isHeld()).toBe(true);
  });

  it('keeps holding on battery above the threshold or when the charge is unknown', async () => {
    const { state, keepAwake } = setup();
    state.onBattery = true;
    state.working = true;
    keepAwake.recompute();
    await vi.advanceTimersByTimeAsync(0);
    expect(keepAwake.isHeld()).toBe(true);

    state.percent = null;
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS);
    expect(keepAwake.isHeld()).toBe(true);
  });

  it('reads the battery only while working on battery', async () => {
    const { state, readBatteryPercent, keepAwake } = setup();
    state.onBattery = true;
    keepAwake.recompute();
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS * 3);
    expect(readBatteryPercent).not.toHaveBeenCalled();

    state.onBattery = false;
    state.working = true;
    keepAwake.recompute();
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS * 3);
    expect(readBatteryPercent).not.toHaveBeenCalled();

    state.onBattery = true;
    keepAwake.onBattery();
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS * 2);
    expect(readBatteryPercent).toHaveBeenCalledTimes(3);
  });

  it('releases the blocker and stops every timer on dispose', async () => {
    const { state, blocker, readBatteryPercent, keepAwake } = setup();
    state.onBattery = true;
    state.working = true;
    keepAwake.recompute();
    keepAwake.dispose();
    expect(blocker.stop).toHaveBeenCalledWith(7);

    const reads = readBatteryPercent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BATTERY_POLL_MS * 3);
    expect(readBatteryPercent).toHaveBeenCalledTimes(reads);
    keepAwake.recompute();
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });
});

describe('parseBatteryPercent', () => {
  it('reads the internal battery charge from pmset', () => {
    const output =
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t85%; discharging; 3:12 remaining present: true\n";
    expect(parseBatteryPercent(output)).toBe(85);
  });

  it('reads the internal battery, not a UPS listed before it', () => {
    const output = [
      "Now drawing from 'Battery Power'",
      ' -CP1500PFCLCD (id=1234)\t100%; AC attached; not charging present: true',
      ' -InternalBattery-0 (id=21234531)\t8%; discharging; (no estimate) present: true',
    ].join('\n');
    expect(parseBatteryPercent(output)).toBe(8);
  });

  it('returns null on a Mac without a battery', () => {
    expect(parseBatteryPercent("Now drawing from 'AC Power'\n")).toBeNull();
  });
});

describe('work activity', () => {
  beforeEach(() => _resetWorkActivityForTests());

  it('notifies only when a source flips between busy and idle', () => {
    const listener = vi.fn();
    onWorkChange(listener);
    reportWork('agent-turns', true);
    reportWork('agent-turns', true);
    reportWork('flow-nodes', true);
    reportWork('agent-turns', false);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(isWorkActive()).toBe(true);
    reportWork('flow-nodes', false);
    expect(isWorkActive()).toBe(false);
  });

  it('keeps a throwing listener out of the registry mutation that reported', () => {
    // A failing keep-awake recompute (e.g. the DB closing at quit) must not break an agent turn.
    const after = vi.fn();
    onWorkChange(() => {
      throw new Error('database closed');
    });
    onWorkChange(after);
    expect(() => reportWork('background-waits', true)).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(isWorkActive()).toBe(true);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onWorkChange(listener);
    unsubscribe();
    reportWork('agent-turns', true);
    expect(listener).not.toHaveBeenCalled();
  });
});
