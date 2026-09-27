import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ active: false, held: false }));
vi.mock('../streaming/execution-registry', () => ({
  getActiveExecution: () => (state.active ? {} : undefined),
}));
vi.mock('../streaming/live-stream', () => ({
  getLiveStreamSeed: () => ({ streams: state.held ? [{ status: 'held' }] : [] }),
}));
import { withMessageAdmission } from './send-admission';

beforeEach(() => {
  state.active = false;
  state.held = false;
});

describe('non-preempting send admission', () => {
  it('waits for an earlier desktop registration then refuses mobile before persisting', async () => {
    let registered!: () => void;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const desktop = withMessageAdmission('race', false, async (started) => {
      registered = () => {
        state.active = true;
        started();
      };
      entered();
    });
    await firstEntered;
    const persistMobile = vi.fn();
    const mobile = withMessageAdmission('race', true, persistMobile);
    const rejection = expect(mobile).rejects.toThrow('already running');
    registered();
    await desktop;
    await rejection;
    expect(persistMobile).not.toHaveBeenCalled();
  });

  it('releases admission after an executor preflight failure', async () => {
    await expect(
      withMessageAdmission('failure', true, async (started) => {
        started(new Error('project gone'));
      }),
    ).rejects.toThrow('project gone');
    await expect(
      withMessageAdmission('failure', true, async (started) => started()),
    ).resolves.toBeUndefined();
  });

  it('rejects a persisted duplicate without claiming execution succeeded or dispatching again', async () => {
    state.active = true;
    const dispatch = vi.fn();
    await expect(
      withMessageAdmission('duplicate', true, dispatch, async () => true),
    ).rejects.toThrow('already saved');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses a held background turn before dispatch', async () => {
    state.held = true;
    const dispatch = vi.fn();
    await expect(withMessageAdmission('held', true, dispatch)).rejects.toThrow('already running');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
