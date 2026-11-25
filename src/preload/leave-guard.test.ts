import { describe, expect, it, vi } from 'vitest';
import { LEAVE_CHANNELS } from '../shared/leave-reason';
import { createLeaveGuardApi } from './leave-guard';

function setup() {
  const ipc = { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  return { ipc, api: createLeaveGuardApi(ipc) };
}

describe('leaveGuardApi', () => {
  it('unsubscribes the very handler it registered, so a remounted guard answers a request once', () => {
    const { ipc, api } = setup();
    const callback = vi.fn();
    const unsubscribe = api.onLeaveRequested(callback);
    const [channel, handler] = ipc.on.mock.calls[0];

    handler({}, 'quit');
    unsubscribe();

    expect(channel).toBe(LEAVE_CHANNELS.request);
    expect(callback).toHaveBeenCalledWith('quit');
    expect(ipc.removeListener).toHaveBeenCalledWith(channel, handler);
  });

  it("sends each answer on the channel main's guard listens to", () => {
    const { ipc, api } = setup();
    api.setHasUnsavedEdits(true);
    api.ackLeave();
    api.confirmLeave();
    api.cancelLeave();

    expect(ipc.send.mock.calls).toEqual([
      [LEAVE_CHANNELS.setUnsaved, true],
      [LEAVE_CHANNELS.ack],
      [LEAVE_CHANNELS.confirm],
      [LEAVE_CHANNELS.cancel],
    ]);
  });
});
