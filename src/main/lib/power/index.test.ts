import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeepAwakeService, type PowerApi } from './index';
import { _resetWorkActivityForTests, reportWork } from './work-activity';

function fakePower() {
  const monitor = new EventEmitter();
  const power: PowerApi = {
    blocker: { start: vi.fn(() => 11), stop: vi.fn() },
    isOnBattery: () => false,
    watchPowerSource: ({ onBattery, onAc }) => {
      monitor.on('on-battery', onBattery).on('on-ac', onAc);
      return () => monitor.off('on-battery', onBattery).off('on-ac', onAc);
    },
    onQuit: (listener) => {
      monitor.on('before-quit', listener);
      return () => monitor.off('before-quit', listener);
    },
    readBatteryPercent: async () => null,
  };
  return { power, monitor };
}

function setup() {
  const { power, monitor } = fakePower();
  let stored: boolean | undefined;
  const service = createKeepAwakeService(power, {
    get: () => stored,
    set: (enabled) => (stored = enabled),
  });
  return { service, monitor, blocker: power.blocker, stored: () => stored };
}

beforeEach(() => _resetWorkActivityForTests());

describe('keep awake service', () => {
  it('holds the blocker for reported work, on by default', () => {
    const { service, blocker } = setup();
    expect(service.isEnabled()).toBe(true);
    service.start();
    reportWork('flow-nodes', true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });

  it('picks up work that was already live when it started', () => {
    const { service, blocker } = setup();
    reportWork('agent-turns', true);
    service.start();
    service.start();
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });

  it('saves the setting and releases at once when it is turned off mid-run', () => {
    const { service, blocker, stored } = setup();
    service.start();
    reportWork('background-waits', true);
    expect(service.setEnabled(false)).toBe(false);
    expect(blocker.stop).toHaveBeenCalledWith(11);
    expect(stored()).toBe(false);
    expect(service.isEnabled()).toBe(false);
  });

  it('releases on quit by itself and detaches every listener', () => {
    const { service, blocker, monitor } = setup();
    service.start();
    reportWork('agent-turns', true);
    monitor.emit('before-quit');
    expect(blocker.stop).toHaveBeenCalledWith(11);
    expect(monitor.eventNames()).toEqual([]);

    reportWork('agent-turns', false);
    reportWork('agent-turns', true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });
});
