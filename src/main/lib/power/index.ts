import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, powerMonitor, powerSaveBlocker } from 'electron';
import { getDatabase } from '../db';
import { getPreference, setPreference } from '../db/repos/composer-settings';
import {
  createKeepAwake,
  type KeepAwake,
  type KeepAwakeDeps,
  parseBatteryPercent,
} from './keep-awake';
import { isWorkActive, onWorkChange } from './work-activity';

export type PowerApi = Pick<KeepAwakeDeps, 'blocker' | 'readBatteryPercent'> & {
  isOnBattery: () => boolean;
  /** Subscribes to the charger being unplugged / connected; returns the unsubscribe. */
  watchPowerSource: (handlers: { onBattery: () => void; onAc: () => void }) => () => void;
  /** Runs `listener` as the app starts quitting; returns the unsubscribe. */
  onQuit: (listener: () => void) => () => void;
};

export type KeepAwakePreference = {
  get: () => boolean | undefined;
  set: (enabled: boolean) => void;
};

/** Keeps the system (not the display) awake while agents, background waits or Flow nodes run. */
export function createKeepAwakeService(power: PowerApi, preference: KeepAwakePreference) {
  let keepAwake: KeepAwake | null = null;
  let unsubscribe: (() => void) | null = null;
  const isEnabled = () => preference.get() ?? true;

  const service = {
    isEnabled,
    setEnabled(enabled: boolean): boolean {
      preference.set(enabled);
      keepAwake?.recompute();
      return enabled;
    },
    start(): void {
      if (keepAwake) return;
      const instance = createKeepAwake({
        blocker: power.blocker,
        isWorking: isWorkActive,
        isEnabled,
        isOnBattery: power.isOnBattery,
        readBatteryPercent: power.readBatteryPercent,
      });
      const stopWatchingWork = onWorkChange(instance.recompute);
      const stopWatchingPower = power.watchPowerSource(instance);
      const stopWatchingQuit = power.onQuit(service.stop);
      unsubscribe = () => {
        stopWatchingWork();
        stopWatchingPower();
        stopWatchingQuit();
      };
      keepAwake = instance;
      instance.recompute();
    },
    stop(): void {
      unsubscribe?.();
      unsubscribe = null;
      keepAwake?.dispose();
      keepAwake = null;
    },
  };
  return service;
}

export type KeepAwakeService = ReturnType<typeof createKeepAwakeService>;

const KEEP_AWAKE_KEY = 'power.keepAwakeWhileWorking';
const execFileAsync = promisify(execFile);

const electronPower: PowerApi = {
  blocker: {
    start: () => powerSaveBlocker.start('prevent-app-suspension'),
    stop: (id) => powerSaveBlocker.stop(id),
  },
  isOnBattery: () => powerMonitor.isOnBatteryPower(),
  watchPowerSource: ({ onBattery, onAc }) => {
    powerMonitor.on('on-battery', onBattery);
    powerMonitor.on('on-ac', onAc);
    return () => {
      powerMonitor.off('on-battery', onBattery);
      powerMonitor.off('on-ac', onAc);
    };
  },
  onQuit: (listener) => {
    app.on('before-quit', listener);
    return () => app.off('before-quit', listener);
  },
  readBatteryPercent: async () => {
    if (process.platform !== 'darwin') return null;
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { timeout: 5000 });
    return parseBatteryPercent(stdout);
  },
};

let service: KeepAwakeService = createKeepAwakeService(electronPower, {
  get: () => getPreference<boolean>(getDatabase(), KEEP_AWAKE_KEY),
  set: (enabled) => setPreference(getDatabase(), KEEP_AWAKE_KEY, enabled),
});

/** Swaps the service, so tests of its callers run without Electron's power APIs. */
export function setKeepAwakeService(next: KeepAwakeService): void {
  service = next;
}

export const startKeepAwake = () => service.start();
export const getKeepAwakeEnabled = () => service.isEnabled();
export const setKeepAwakeEnabled = (enabled: boolean) => service.setEnabled(enabled);
