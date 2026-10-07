import type {
  BackgroundTaskSummary,
  Query,
  SDKMessage,
  StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as sentry from '../sentry/init';
import { createTaskStopHook, type TaskStopHook } from '../task-stop-hook';
import {
  __resetSessionsForTest,
  type ClaudeSession,
  createSession,
  getSession,
  IDLE_TTL_MS,
} from './claude-session-registry';
import { createClaudeTurnContext } from './claude-turn-context';
import {
  armWakePump,
  hasWakeHold,
  releaseWakeHold,
  takeWakeHold,
  type WakeHoldIo,
} from './claude-wake-hold';

const workflow: BackgroundTaskSummary = {
  id: 'w1',
  type: 'workflow',
  status: 'running',
  description: 'Build the iPhone redesign',
  name: 'frink-mobile-build',
};

const stopListing = (tasks: BackgroundTaskSummary[]): StopHookInput => ({
  hook_event_name: 'Stop',
  stop_hook_active: false,
  background_tasks: tasks,
  session_id: 'sess',
  transcript_path: '',
  cwd: '',
});

/** A frame the wake pump routes on `type` and `subtype` alone. */
function frame(fields: { type: string; subtype?: string; task_id?: string; status?: string }) {
  // SAFETY: the pump and its burst transformer read only these fields on these fakes.
  return fields as SDKMessage;
}

/** A Query the test feeds by hand; `end` is the CLI's stream ending. */
function liveQuery() {
  const buffer: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const release = () => {
    wake?.();
    wake = null;
  };
  async function* frames(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      while (buffer.length > 0) {
        const next = buffer.shift();
        if (next) yield next;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const fake = Object.assign(frames(), { interrupt: async () => release() });
  // SAFETY: the session loop calls only next(), return() and interrupt() on a held query.
  const query = fake as Query;
  return {
    query,
    emit: (m: SDKMessage) => {
      buffer.push(m);
      release();
    },
    end: () => {
      ended = true;
      release();
    },
  };
}

const recordingIo = (): WakeHoldIo => ({
  chatId: 'c1',
  streamChunk: vi.fn(),
  emitPlanCard: vi.fn(async () => {}),
  completeBurst: vi.fn(async () => {}),
  setHeld: vi.fn(),
  clearPendingApprovals: vi.fn(),
  getLatestTaskSignal: vi.fn(() => null),
  clearCurrentExecutionChat: vi.fn(),
});

const heldValues = (io: WakeHoldIo) => vi.mocked(io.setHeld).mock.calls.map(([held]) => held);
/** Everything the chat was told across every completed burst, as one string. */
const persisted = (io: WakeHoldIo) => JSON.stringify(vi.mocked(io.completeBurst).mock.calls);
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A held session whose arming turn's Stop listed a running Workflow. */
async function armWorkflow(subChatId: string) {
  const ch = liveQuery();
  const io = recordingIo();
  const stopHook: TaskStopHook = createTaskStopHook({
    hasSignal: () => true,
    isAborted: () => false,
  });
  await stopHook(stopListing([workflow]));
  const session: ClaudeSession = createSession(subChatId, () => ch.query, { stopHook });
  const turn = createClaudeTurnContext();
  turn.msgId = 'arming-msg';
  session.currentTurn = turn;
  const pendingWork = stopHook.lastPendingWork;
  if (!pendingWork) throw new Error('the arming Stop listed no work');
  armWakePump({
    session,
    pendingWork,
    subChatId,
    executionContextId: undefined,
    signalTaskId: null,
    io,
  });
  return { ch, io, session, stopHook };
}

describe('claude-wake-hold — background Workflows and lost-work notices', () => {
  let capture: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetSessionsForTest();
    capture = vi.spyOn(sentry, 'captureMainException');
  });

  it('keeps holding past the idle TTL and through another task’s wake burst', async () => {
    vi.useFakeTimers();
    try {
      const { ch, io, session, stopHook } = await armWorkflow('lw1');
      // Longer than any idle-session timer: a hold must not be on that clock at all.
      await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 3);
      // A backgrounded command finishing wakes the CLI; its Stop still lists the Workflow.
      ch.emit(frame({ type: 'system', subtype: 'task_notification', task_id: 'b1' }));
      await stopHook(stopListing([workflow]));
      ch.emit(frame({ type: 'result', subtype: 'success' }));
      await vi.advanceTimersByTimeAsync(0);

      expect(hasWakeHold('lw1')).toBe(true);
      expect(getSession('lw1')).toBe(session);
      expect(session.retained).toBeNull();
      expect(heldValues(io)).not.toContain(false);
      ch.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the chat, before retracting, when the CLI dies under a held Workflow', async () => {
    const { ch, io } = await armWorkflow('lw2');
    ch.end();
    await settle();

    expect(persisted(io)).toContain('Background work stopped');
    expect(persisted(io)).toContain('Workflow “frink-mobile-build”');
    // Ordered: the notice completes while the arming message's live stream is still open.
    const completeAt = vi.mocked(io.completeBurst).mock.invocationCallOrder.at(-1) ?? 0;
    const retractAt = vi.mocked(io.setHeld).mock.invocationCallOrder.at(-1) ?? 0;
    expect(completeAt).toBeLessThan(retractAt);
    expect(io.setHeld).toHaveBeenLastCalledWith(false, undefined, 'failed');
  });

  it('tells the chat once when a teardown nobody asked for releases the hold', async () => {
    const { ch, io } = await armWorkflow('lw3');
    releaseWakeHold('lw3', 'provider-switch:codex');
    expect(heldValues(io)).toEqual([true]); // the notice goes first
    ch.end();
    await settle();

    expect(persisted(io)).toContain('this chat switched to another agent provider');
    // No 'failed' chime: a release lands beside the user's own new turn.
    expect(io.setHeld).toHaveBeenLastCalledWith(false, undefined, undefined);
    expect(hasWakeHold('lw3')).toBe(false);
    // The release posts it and the pump's settle asks again: one notice.
    const last = JSON.stringify(vi.mocked(io.completeBurst).mock.calls.at(-1));
    expect(last.split('Background work stopped').length - 1).toBe(1);
  });

  it('still retracts, and reports, when posting the notice fails', async () => {
    const { ch, io } = await armWorkflow('lw4');
    vi.mocked(io.completeBurst).mockRejectedValueOnce(new Error('persist failed'));
    releaseWakeHold('lw4', 'provider-switch:codex');
    await settle();

    // A row left up after the session is gone would read as work still running.
    expect(heldValues(io)).toEqual([true, false]);
    expect(capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ stage: 'lost-work-notice' }),
    );
    ch.end();
  });

  it('says nothing when the user stopped the work themselves', async () => {
    const { ch, io } = await armWorkflow('lw5');
    releaseWakeHold('lw5', 'user-pause');
    expect(heldValues(io)).toEqual([true, false]); // still retracts on the keystroke
    ch.end();
    await settle();

    expect(persisted(io)).not.toContain('Background work stopped');
  });

  it('does not re-advertise the wait from a burst ending after such a release', async () => {
    const { ch, io } = await armWorkflow('lw6');
    ch.emit(frame({ type: 'system', subtype: 'task_notification', task_id: 'b1' }));
    releaseWakeHold('lw6', 'provider-switch:codex');
    ch.emit(frame({ type: 'result', subtype: 'success' }));
    await settle();
    ch.end();
    await settle();

    expect(heldValues(io)).toEqual([true, false]);
  });

  it('says nothing when the work was declared finished before the CLI exited', async () => {
    const { ch, io, stopHook } = await armWorkflow('lw7');
    // The Workflow finished: the burst's Stop lists nothing, so the wait ends and stdin closes.
    ch.emit(frame({ type: 'system', subtype: 'task_notification', task_id: 'w1' }));
    await stopHook(stopListing([]));
    ch.emit(frame({ type: 'result', subtype: 'success' }));
    await settle();
    expect(io.setHeld).toHaveBeenLastCalledWith(false, undefined, 'wait-over');
    ch.end();
    await settle();

    expect(persisted(io)).not.toContain('Background work stopped');
  });

  it('says nothing when a follow-up turn took the hold over before the stream ended', async () => {
    const { ch, io } = await armWorkflow('lw8');
    expect(takeWakeHold('lw8')).toBeDefined();
    ch.end();
    await settle();

    // The adopting turn owns the session now; its own turn end decides what happens to the work.
    expect(persisted(io)).not.toContain('Background work stopped');
  });
});
