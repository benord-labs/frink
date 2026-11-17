import log from 'electron-log';

export const RELEASE_DELAY_MS = 30_000;
export const BATTERY_POLL_MS = 3 * 60_000;
const LOW_BATTERY_PERCENT = 10;

export type KeepAwakeDeps = {
  blocker: { start: () => number; stop: (id: number) => void };
  isWorking: () => boolean;
  isEnabled: () => boolean;
  isOnBattery: () => boolean;
  readBatteryPercent: () => Promise<number | null>;
};

export type KeepAwake = {
  recompute: () => void;
  onBattery: () => void;
  onAc: () => void;
  dispose: () => void;
  isHeld: () => boolean;
};

/** The internal battery's charge from `pmset -g batt`; `null` on a Mac without one. */
export function parseBatteryPercent(pmsetOutput: string): number | null {
  const match = /InternalBattery[^\n]*?(\d{1,3})%/.exec(pmsetOutput);
  return match ? Number(match[1]) : null;
}

/** One sleep blocker while work is live; release waits RELEASE_DELAY_MS so handoffs don't flap it.
 * Battery comes from `pmset` in main (no charge API there); a low lock clears only on the charger. */
export function createKeepAwake(deps: KeepAwakeDeps): KeepAwake {
  let blockerId: number | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let batteryPoll: ReturnType<typeof setInterval> | null = null;
  let lowBattery = false;
  let disposed = false;

  const cancelRelease = () => {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = null;
  };

  const hold = () => {
    cancelRelease();
    if (blockerId === null) blockerId = deps.blocker.start();
  };

  const release = () => {
    cancelRelease();
    if (blockerId === null) return;
    deps.blocker.stop(blockerId);
    blockerId = null;
  };

  const checkBattery = async () => {
    const percent = await deps.readBatteryPercent().catch(() => null);
    if (disposed || lowBattery || percent === null || !deps.isOnBattery()) return;
    if (percent >= LOW_BATTERY_PERCENT) return;
    log.info('[KeepAwake] Battery low, letting the Mac sleep until it is charging', { percent });
    lowBattery = true;
    recompute();
  };

  const syncBatteryPoll = (wanted: boolean) => {
    const shouldPoll = wanted && deps.isOnBattery();
    if (shouldPoll && !batteryPoll) {
      batteryPoll = setInterval(() => void checkBattery(), BATTERY_POLL_MS);
      void checkBattery();
    } else if (!shouldPoll && batteryPoll) {
      clearInterval(batteryPoll);
      batteryPoll = null;
    }
  };

  function recompute(): void {
    if (disposed) return;
    const allowed = deps.isEnabled() && !lowBattery;
    const working = deps.isWorking();
    if (!allowed) release();
    else if (working) hold();
    else if (blockerId !== null && !releaseTimer) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (!deps.isWorking()) release();
      }, RELEASE_DELAY_MS);
    }
    syncBatteryPoll(allowed && working);
  }

  return {
    recompute,
    onBattery: recompute,
    onAc: () => {
      lowBattery = false;
      recompute();
    },
    dispose: () => {
      disposed = true;
      release();
      syncBatteryPoll(false);
    },
    isHeld: () => blockerId !== null,
  };
}
