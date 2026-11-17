import log from 'electron-log';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../db';
import * as teardown from '../../trpc/routers/chats/teardown-worktree';
import * as batchDispatch from '../batch-dispatch';
import * as usageTelemetry from '../usage-telemetry';
import { recoverWorktreesOnBoot, startRunTerminalListeners } from './index';

const unsubscribe = () => undefined;

describe('startRunTerminalListeners', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts both run-terminal listeners at boot', async () => {
    const batch = vi.spyOn(batchDispatch, 'startBatchAdvanceListener').mockReturnValue(unsubscribe);
    const usage = vi.spyOn(usageTelemetry, 'startFlowRunTelemetry').mockReturnValue(unsubscribe);

    await startRunTerminalListeners();

    expect(batch).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();
  });

  it('still counts runs when the batch listener fails to start', async () => {
    vi.spyOn(batchDispatch, 'startBatchAdvanceListener').mockImplementation(() => {
      throw new Error('batch listener failed');
    });
    const usage = vi.spyOn(usageTelemetry, 'startFlowRunTelemetry').mockReturnValue(unsubscribe);

    await startRunTerminalListeners();

    expect(usage).toHaveBeenCalledOnce();
  });
});

describe('recoverWorktreesOnBoot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs recovery against the database alone, with no worktree folder to scan', async () => {
    // SAFETY: recovery is stubbed below, so the handle is only passed through, never used.
    const handle = {} as ReturnType<typeof db.getDatabase>;
    vi.spyOn(db, 'getDatabase').mockReturnValue(handle);
    const recover = vi
      .spyOn(teardown, 'recoverOrphanedWorktrees')
      .mockResolvedValue({ pruned: 1, removed: 0, skipped: 2 });
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    await recoverWorktreesOnBoot();

    expect(recover.mock.calls).toEqual([[handle]]);
    expect(info).toHaveBeenCalledWith('[Main] recoverOrphanedWorktrees reclaimed', {
      pruned: 1,
      removed: 0,
      skipped: 2,
    });
  });

  it('logs nothing when there was no drift', async () => {
    // SAFETY: recovery is stubbed below, so the handle is only passed through, never used.
    vi.spyOn(db, 'getDatabase').mockReturnValue({} as ReturnType<typeof db.getDatabase>);
    vi.spyOn(teardown, 'recoverOrphanedWorktrees').mockResolvedValue({
      pruned: 0,
      removed: 0,
      skipped: 0,
    });
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    await recoverWorktreesOnBoot();

    expect(info).not.toHaveBeenCalled();
  });
});
