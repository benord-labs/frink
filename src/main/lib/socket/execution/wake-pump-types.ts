import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The wake pump's public contract, split out of `claude-session-registry.ts` so that file stays
 * under its size cap. Types only — the pump itself lives with the session loop because it
 * drives the same shared generator.
 */

/** How a wake pump ended. Always delivered via {@link WakePump.done} (never a rejection) so the
 * executor's arming call site stays fire-and-observe. */
export type WakePumpExit =
  | { reason: 'turn-taken-over' }
  | { reason: 'turn-error'; error: unknown }
  /** The wait ended, stdin closed, and the CLI then finished and ended its own stream. */
  | { reason: 'work-finished'; bursts: number }
  | { reason: 'interrupted' }
  | { reason: 'stream-ended' }
  | { reason: 'sink-error'; error: unknown };

export interface WakePumpCallbacks {
  /** A wake burst is starting (first message after idle). The executor opens a fresh
   * assistant-message scope here — each burst renders and persists as its own message. */
  onBurstStart: () => void;
  /** Every SDK message of the current burst, in order. */
  onMessage: (m: SDKMessage) => void | Promise<void>;
  /** The burst's terminal `result` frame arrived. */
  onBurstEnd: (result: SDKMessage) => void | Promise<void>;
  /** {@link isWorkFinished} just reported the wait over. Retract the held row here: this is the
   * wait's ADVERTISEMENT ending, not its stream — bursts may still arrive and must still persist. */
  onWaitOver: () => void;
  /**
   * Consulted after every burst: true once the harness reports nothing left in flight. The pump
   * holds no policy of its own — the arming side owns what "still working" means, and nothing else
   * ends a wait.
   *
   * A true reading ends the wait's ADVERTISEMENT and closes stdin; it never stops the reader. The
   * snapshot behind it is taken at the burst's own stop, so a task that finished moments earlier
   * has already left the list while the notification reporting it is still queued — and the CLI
   * keeps writing complete turns for seconds after EOF. Note this can only be evaluated when a wake
   * ARRIVES: the loop blocks on the generator, so a CLI that stops waking is left to the flow
   * watcher's quiet-idle sweep.
   */
  isWorkFinished: () => boolean;
}

export interface WakePump {
  done: Promise<WakePumpExit>;
  /**
   * Hand the generator to a real user turn. Pushes `message` into the session queue (immediately
   * when the pump is idle; after the in-flight burst's `result` when one is mid-stream) and routes
   * every subsequent SDK message to `onMessage` until the turn's `result` — the pump then exits
   * `turn-taken-over`. Resolves like `runTurn`: on the result frame, or on a caller interrupt.
   * Callable once.
   *
   * Known ~ms race, accepted: a task settling in the instant between an idle pump's takeover push
   * and the CLI processing it gets its notification turn attributed to the user turn (the CLI
   * serializes turns, so frames never interleave — attribution, not corruption, is the blast
   * radius).
   */
  startTurn: (
    message: SDKUserMessage,
    onMessage: (m: SDKMessage) => void | Promise<void>,
    /** Runs after any burst ends and before pushing the turn, so the executor can safely swap
     * `session.currentTurn`. Return false if asynchronous preparation finds it cancelled. */
    beforePush?: () => boolean | undefined | Promise<boolean | undefined>,
    /** Fired once when the turn's message actually lands on the CLI input queue. */
    onPushed?: () => void,
  ) => Promise<void>;
  /** True once the loop exits. An ended pump has no queue reader and cannot be adopted. */
  isEnded: () => boolean;
  /** Re-check {@link WakePumpCallbacks.isWorkFinished} outside a burst, for a change no turn will
   * follow (a user-stopped shell or workflow). A no-op mid-burst, with a takeover queued, or once over. */
  settleIfWorkFinished: () => void;
}
