import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearActiveExecutionsForTests,
  deleteActiveExecution,
  getExecutionStreamEpoch,
  setActiveExecution,
} from '../streaming/execution-registry';
import {
  _clearLiveStreamRegistryForTests,
  beginLiveStreamCompletion,
  getLiveStreamSeed,
  recordLiveStreamStart,
} from '../streaming/live-stream';
import { withMessageAdmission } from './send-admission';

beforeEach(() => {
  _clearActiveExecutionsForTests();
  _clearLiveStreamRegistryForTests();
});

/** Registers the turn and acknowledges admission, as the executor does before it streams. */
function executorDispatch(subChatId: string) {
  return vi.fn(async (started: (error?: Error) => void) => {
    setActiveExecution(subChatId, new AbortController());
    started();
  });
}

/** A turn that ended with background work still pending: a held stream and no execution. */
function parkOnBackgroundWork(subChatId: string): void {
  setActiveExecution(subChatId, new AbortController(), undefined, {
    chatId: 'chat',
    assistantMessageId: 'arming',
  });
  const streamEpoch = getExecutionStreamEpoch(subChatId, 'arming');
  if (!streamEpoch) throw new Error('execution registered without an epoch');
  const stream = { chatId: 'chat', subChatId, assistantMessageId: 'arming', streamEpoch };
  recordLiveStreamStart(stream);
  beginLiveStreamCompletion({ ...stream, continuesWakeHold: true });
  deleteActiveExecution(subChatId);
  expect(getLiveStreamSeed(subChatId).streams).toEqual([
    expect.objectContaining({ status: 'held' }),
  ]);
}

describe('non-preempting send admission', () => {
  it('waits for an earlier desktop registration then refuses mobile before persisting', async () => {
    parkOnBackgroundWork('race');
    let registered!: () => void;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const desktop = withMessageAdmission('race', false, async (started) => {
      registered = () => {
        setActiveExecution('race', new AbortController());
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
    setActiveExecution('duplicate', new AbortController());
    const dispatch = vi.fn();
    await expect(
      withMessageAdmission('duplicate', true, dispatch, async () => true),
    ).rejects.toThrow('already saved');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('admits a phone send into a background wait, as a desktop send is', async () => {
    parkOnBackgroundWork('held');
    const dispatch = executorDispatch('held');
    await expect(withMessageAdmission('held', true, dispatch)).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('still refuses a phone send while a turn is executing', async () => {
    setActiveExecution('active', new AbortController());
    const dispatch = vi.fn();
    await expect(withMessageAdmission('active', true, dispatch)).rejects.toThrow('already running');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('admits exactly one of two phone sends racing into a background wait', async () => {
    parkOnBackgroundWork('pair');
    const first = executorDispatch('pair');
    const second = executorDispatch('pair');
    const results = await Promise.allSettled([
      withMessageAdmission('pair', true, first),
      withMessageAdmission('pair', true, second),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
});
