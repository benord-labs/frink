import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { captureMainMessage } from '../../sentry/init';
import type { ClaudeSession } from '../claude-session-registry';
import { clearSubagentTasks } from '../streaming/subagent-task-status';
import type { WakePumpCallbacks } from './wake-pump-types';

/**
 * What happens when a wait is over: settle its ADVERTISEMENT, close stdin, and keep reading.
 *
 * The liveness rule behind `isWorkFinished` (an empty Stop-hook snapshot, or the agent's own
 * declared done) describes the harness's task list, not the stream. The CLI writes complete queued
 * turns for seconds after its stdin closes, so a consumer that stops reading on that rule loses
 * whatever was still being written — measured in the field as the model's final answer reaching the
 * CLI's transcript and never the chat. See decision `unattended-wake-budget`.
 *
 * So the rule retracts the held row, clears the subagent roster, releases the busy span and closes
 * stdin — which is still what stops the CLI's backgrounded tasks — and the reader carries on to the
 * generator's own end. Nothing flow-scoped is released here: the admission lease, runtime slot,
 * abort registration and settlement barrier all stay on the disposal path, so a cleanup failure
 * still retains capacity (decision `flow-admission-capacity-lifecycle`).
 */

/**
 * The drain's only bound, for a CLI that never exits after EOF. Not a wait ceiling: it arms only
 * once the wait is already over, restarts on every burst, and refuses to fire while one is open —
 * a burst parked on an approval or an unanswered question has no result frame, so it stays open.
 */
const REAP_QUIET_MS = 60_000;

export interface WaitOverDrain {
  /** A burst opened after stdin closed — the frame the old stand-down window used to lose.
   * Restarts the quiet deadline; ambient chatter never reaches here, so it cannot. */
  noteBurst: (msg: SDKMessage) => void;
  /** The reader is gone — stop the reap. */
  cancel: () => void;
}

function beginWaitOverDrain(params: {
  session: ClaudeSession;
  /** Publish held=false on the same lane every other wait end uses. */
  retract: () => void;
  releaseBusy: () => void;
  isBurstOpen: () => boolean;
}): WaitOverDrain {
  const { session } = params;
  params.retract();
  clearSubagentTasks(session.subChatId);
  params.releaseBusy();
  if (!session.queue.closed) session.queue.close();
  const closedAt = Date.now();
  let timer: NodeJS.Timeout | null = null;
  const armReap = (): void => {
    timer = setTimeout(() => {
      if (params.isBurstOpen()) return armReap();
      // One empty macrotask before the kill: query.return() closes the transport ahead of the
      // generator, so a frame already inside its delivery pipeline at the deadline would be
      // discarded unseen. The extra tick lets pending I/O land first — a photo-finish tie breaks
      // toward the work, and the burst it opens re-arms the deadline instead of dying with it.
      timer = setTimeout(() => {
        if (params.isBurstOpen()) return armReap();
        captureMainMessage('wake drain reaped a CLI that never exited after EOF', 'warning', {
          surface: 'wake-pump-stand-down',
          subChatId: session.subChatId,
        });
        void session.query.return(undefined);
      }, 0);
    }, REAP_QUIET_MS).unref();
  };
  armReap();
  return {
    noteBurst: (msg) => {
      if (timer) clearTimeout(timer);
      armReap();
      log.info(`[Socket] ${session.subChatId}: wake burst landed after EOF`);
      // The only field measure of how much text the drain saves — a cluster here is the evidence
      // that the old stand-down window was losing turns, and its absence that it was not.
      captureMainMessage('wake burst landed after the wait ended and stdin closed', 'warning', {
        surface: 'wake-pump-stand-down',
        subChatId: session.subChatId,
        frame: msg.type,
        sinceCloseMs: String(Date.now() - closedAt),
      });
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** What the wait-over latch reads and writes of a wake arming. */
type LatchableArming = {
  phase: 'idle' | 'burst';
  drain: WaitOverDrain | null;
  takeover: unknown;
  ended: unknown;
  callbacks: Pick<WakePumpCallbacks, 'isWorkFinished' | 'onWaitOver'>;
};

/** Latch the wait over once its work is finished: idle, nothing queued to take over, latched once,
 * and only while this arming is still the session's own. */
export function settleIfWorkFinished(
  session: ClaudeSession,
  arming: LatchableArming,
  releaseBusy: () => void,
): void {
  if (arming.phase !== 'idle' || arming.takeover || arming.drain || arming.ended) return;
  if (session.loop.arming !== arming || !arming.callbacks.isWorkFinished()) return;
  session.loop.closeExpected = true;
  arming.drain = beginWaitOverDrain({
    session,
    retract: arming.callbacks.onWaitOver,
    releaseBusy,
    isBurstOpen: () => arming.phase === 'burst',
  });
}
