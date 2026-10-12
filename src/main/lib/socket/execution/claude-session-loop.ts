import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { failedResultError } from '../../claude/stream-classifiers';
import type { ClaudeSession } from '../claude-session-registry';
import {
  isAmbientIdleFrame,
  isAnyResult,
  isIdleActivity,
  isSetterEcho,
  isTurnBoundary,
  noteSubagentTaskFrame,
} from '../streaming';
import { drainToResult } from './claude-session/drain-to-result';
import { logTurnTiming, noteTurnTiming, type TurnTiming } from './claude-session/turn-timing';
import type { WakePump, WakePumpCallbacks, WakePumpExit } from './wake-pump-types';
import { settleIfWorkFinished, type WaitOverDrain } from './wake-wait-over';

/**
 * The ONE consumer of a session's shared SDK generator, started with the session and living as long
 * as it does. Foreground turns ({@link runTurn}) and between-turn wake armings ({@link armIdle})
 * REGISTER a sink here instead of driving the generator themselves — two readers would interleave
 * `.next()` and split one turn's frames across both.
 *
 * With no sink registered the loop parks and issues no `.next()` at all: the generator's own pull
 * backpressure is the buffer, so a frame the CLI writes between one registration and the next keeps
 * exactly the timing it has always had. A retained session's reader watches it instead.
 *
 * Imports run one way, registry -> loop: the registry owns session bookkeeping and eviction, which
 * reaches this file only as the pre-bound `session.evict` and `session.retire`.
 */

/** A registered foreground turn. Every frame routes here until the turn's own boundary. */
type TurnSink = TurnTiming & {
  onMessage: (m: SDKMessage) => void | Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  onPushed?: () => void; // once, right after the message lands on the CLI input queue
};

/** Awaited under busy right before a push; false (or a throw) ends the turn unpushed. */
type BeforePush = () => boolean | undefined | Promise<boolean | undefined>;

/** A turn waiting to take a live arming over — held until the push actually happens (immediately
 * at idle, at the in-flight burst's `result` mid-burst). */
type Takeover = TurnSink & { message: SDKUserMessage; beforePush?: BeforePush };

/** One arming of the wake sink. Its `done` is scoped to the ARMING, not the loop: a takeover ends
 * the arming (so the hold it belongs to settles) while the loop reads on for the adopted turn. */
type IdleArming = {
  callbacks: WakePumpCallbacks;
  phase: 'idle' | 'burst';
  bursts: number;
  /** Non-null once this arming's wait was declared over: the advertisement is settled and stdin is
   * closed, and the reader is now salvaging whatever the CLI still writes. */
  drain: WaitOverDrain | null;
  takeover: Takeover | null;
  /** Set before `done` settles so liveness checks see the exit synchronously. */
  ended: WakePumpExit | null;
  startTurn: WakePump['startTurn'];
  resolveDone: (exit: WakePumpExit) => void;
};

export type SessionLoop = {
  spawnedAt: number;
  turn: TurnSink | null;
  arming: IdleArming | null;
  /** Resolves the park between registrations. Set only while parked. */
  wake: (() => void) | null;
  /** Resolves `session.turnSettled` for whichever registration owns the current busy span. */
  settleBusy: (() => void) | null;
  /** The session was ended from outside; a parked loop stops at its next gap. */
  stopped: boolean;
  /** The wait-over drain closed stdin on purpose, so the generator's end is a clean finish rather
   * than a stream death — and an explicit stop now has to end the iterator, not the input. */
  closeExpected: boolean;
  /** The reader returned — the stream is dead or abandoned, so a pushed message would never be read. */
  exited: boolean;
};

/**
 * Null when the caller ended the turn on purpose (plan halt, question park), not a dead query.
 * An unexpected throw or result-less done is a dead query: evict so the next turn recreates.
 */
async function nextTurnMessage(session: ClaudeSession): Promise<SDKMessage | null> {
  let step: IteratorResult<SDKMessage, void>;
  try {
    step = await session.query.next();
  } catch (err) {
    if (session.interruptExpected) return null;
    session.evict();
    throw err;
  }
  if (step.done) {
    if (session.interruptExpected) return null;
    session.evict();
    throw new Error(
      `runTurn: query for ${session.subChatId} ended before the turn produced a result`,
    );
  }
  // Roster writes stop at the wait-over latch: the roster is keyed by subChatId, and once the
  // wait is over a FRESH session for the same chat may own it — a drain frame repopulating it
  // would resurrect a spinner on a chat that renders finished.
  if (!session.loop.closeExpected) noteSubagentTaskFrame(session.subChatId, step.value);
  return step.value;
}

export function createSessionLoop(): SessionLoop {
  return {
    spawnedAt: Date.now(),
    turn: null,
    arming: null,
    wake: null,
    settleBusy: null,
    stopped: false,
    closeExpected: false,
    exited: false,
  };
}

/** Start the session's reader. It parks immediately — nothing is read until a sink registers. */
export function startSessionLoop(session: ClaudeSession): void {
  void readSessionStream(session);
}

/** Start reading a just-retained session through the idle watcher. */
export const watchRetainedSession = (session: ClaudeSession): void => wakeLoop(session.loop);

/** Release a loop parked between registrations (chat close, test teardown). A loop with a live
 * registration is left alone: its stream's own end is the only thing that may stop it. */
export function stopSessionLoop(session: ClaudeSession): void {
  session.loop.stopped = true;
  // Mid-drain the reader is blocked on the generator, not parked, and stdin is already closed —
  // so closing it again decides nothing. Ending the iterator is what actually stops the CLI.
  if (session.loop.closeExpected) void session.query.return(undefined);
  wakeLoop(session.loop);
}

function wakeLoop(loop: SessionLoop): void {
  const wake = loop.wake;
  loop.wake = null;
  wake?.();
}

/** Claim the busy span for a new registration. Synchronous, so a second caller sees it. */
function takeBusy(session: ClaudeSession): void {
  session.busy = true;
  session.lastActiveAt = Date.now();
  session.turnSettled = new Promise<void>((resolve) => {
    session.loop.settleBusy = resolve;
  });
}

/** Release the busy span. Resolve `turnSettled` LAST so anything awaiting it (a follow-up turn)
 * observes the cleared state, and clear `interruptExpected` here so it can only ever be true for
 * the duration of one registration. */
function clearBusy(session: ClaudeSession): void {
  session.busy = false;
  session.interruptExpected = false;
  session.turnSettled = null;
  session.lastActiveAt = Date.now();
  const settle = session.loop.settleBusy;
  session.loop.settleBusy = null;
  settle?.();
}

/**
 * Run ONE user turn on the session's loop and resolve when the turn's own `result` frame arrives —
 * leaving the query open for the next turn. A claimed idle session passes `beforePush`.
 *
 * Adopting a session that is consuming harness wakes goes through that arming's own `startTurn`
 * handle instead: the per-arming identity is what lets a dead arming refuse the adoption rather
 * than masquerade as a fresh turn. Here, any live registration (a foreground turn OR an arming,
 * both of which hold `busy`) is refused: one turn per chat, because the query is a single shared
 * generator.
 */
export function runTurn(
  session: ClaudeSession,
  message: SDKUserMessage,
  onMessage: (m: SDKMessage) => void | Promise<void>,
  beforePush?: BeforePush,
  onPushed?: () => void,
): Promise<void> {
  const loop = session.loop;
  // A drained arming still holds the sink without holding `busy`, so it is checked in its own right.
  if (session.busy || loop.arming) {
    return Promise.reject(
      new Error(`runTurn: a turn is already in progress for ${session.subChatId}`),
    );
  }
  if (loop.exited) {
    // Nothing is reading this session's stream, so a pushed message would hang the caller. Marked
    // adopt-refused: the executor's fresh-session retry is exactly the right recovery.
    return Promise.reject(
      new Error(`runTurn: ${session.subChatId} stopped reading its stream — adopt refused`),
    );
  }
  takeBusy(session);
  return new Promise<void>((resolve, reject) => {
    const path = beforePush ? 'warm' : 'fresh';
    const sink: TurnSink = { onMessage, resolve, reject, onPushed, path };
    loop.turn = sink;
    void pushTurn(session, sink, message, beforePush);
  });
}

/** Push a registered turn's message, synchronously unless it has a `beforePush` to await first. */
async function pushTurn(
  session: ClaudeSession,
  sink: TurnSink,
  message: SDKUserMessage,
  beforePush?: BeforePush,
): Promise<void> {
  try {
    const prepared = beforePush ? await beforePush() : undefined;
    // The stream can end while preparation awaits, which has already ended this turn.
    if (session.loop.turn !== sink) return;
    if (prepared === false)
      throw new Error(`runTurn: ${session.subChatId} refused — adopt refused`);
    session.queue.push(message);
  } catch (err) {
    if (session.loop.turn === sink) endTurn(session, err);
    return;
  }
  sink.pushedAt = Date.now();
  sink.onPushed?.();
  wakeLoop(session.loop);
}

/** End the registered foreground turn: clear the sink, release the busy span, THEN settle the
 * caller — the post-turn pipeline must never run against a session that still reads as busy. */
function endTurn(session: ClaudeSession, error?: unknown): void {
  const sink = session.loop.turn;
  session.loop.turn = null;
  if (sink) logTurnTiming(session, sink);
  clearBusy(session);
  if (error !== undefined) sink?.reject(error);
  else sink?.resolve();
}

/** Consume harness wakes between turns for as long as the arming side reports work in flight. */
export function armIdle(session: ClaudeSession, callbacks: WakePumpCallbacks): WakePump {
  const loop = session.loop;
  if (session.busy || loop.arming) {
    throw new Error(`armIdle: a turn is already in progress for ${session.subChatId}`);
  }
  takeBusy(session);
  let resolveDone!: (exit: WakePumpExit) => void;
  const done = new Promise<WakePumpExit>((resolve) => {
    resolveDone = resolve;
  });
  const arming: IdleArming = {
    callbacks,
    phase: 'idle',
    bursts: 0,
    drain: null,
    takeover: null,
    ended: null,
    resolveDone,
    startTurn: (message, onMessage, beforePush, onPushed) =>
      new Promise<void>((resolve, reject) => {
        if (arming.ended) {
          // Handed over or ended: a push would sit unread. The 'adopt refused' marker is shared
          // with runTurn, endArming and createSession for isPumpAdoptRefusedError; keep it in sync.
          reject(
            new Error(`armIdle: arming already ended (${arming.ended.reason}) — adopt refused`),
          );
          return;
        }
        if (arming.drain) {
          // Wait-over already latched: stdin is closed, so a takeover push could never be read.
          // Busy cleared at the latch, so the caller's fresh-session retry is immediate.
          reject(
            new Error(`armIdle: the wait is already over for ${session.subChatId} — adopt refused`),
          );
          return;
        }
        if (arming.takeover) {
          reject(new Error('armIdle: startTurn already called'));
          return;
        }
        arming.takeover = {
          message,
          onMessage,
          beforePush,
          onPushed,
          resolve,
          reject,
          path: 'adopted',
        };
        // Mid-burst: the push waits for the burst's `result` (the CLI serializes turns anyway —
        // pushing now would only widen the misattribution window). Idle: push immediately so the
        // pending `.next()` resolves from the new turn's frames.
        if (arming.phase === 'idle') void pushTakeover(session, arming);
      }),
  };
  loop.arming = arming;
  // Nothing is reading this session's stream (the chat closed while this arming was being
  // prepared), so the sink would sit unread and the hold behind it would never settle — end it now
  // instead, and its cleanup releases the flow lease and runtime slot it carries.
  if (loop.exited) endArming(session, { reason: 'stream-ended' });
  else wakeLoop(loop);
  return {
    done,
    isEnded: () => arming.ended !== null,
    startTurn: arming.startTurn,
    settleIfWorkFinished: () => settleIfWorkFinished(session, arming, () => clearBusy(session)),
  };
}

async function pushTakeover(session: ClaudeSession, arming: IdleArming): Promise<void> {
  const takeover = arming.takeover;
  if (!takeover) return;
  // The user's turn owns the stream from here, so a frame arriving while preparation awaits must
  // not open a fresh burst behind it.
  session.loop.turn = takeover;
  try {
    const prepared = takeover.beforePush ? await takeover.beforePush() : undefined;
    if (prepared === false) {
      endArming(session, { reason: 'interrupted' });
      return;
    }
    // The arming may end while preparation awaits; endArming rejects the unpushed takeover.
    if (arming.ended) return;
    session.queue.push(takeover.message);
    takeover.pushedAt = Date.now();
    takeover.onPushed?.();
  } catch (err) {
    endArming(session, { reason: 'turn-error', error: err }, err);
  }
}

/** End the live arming: clear it (the loop falls back to reading nothing), release the busy span,
 * settle any takeover, and only then deliver the exit its hold's cleanup runs on. */
function endArming(session: ClaudeSession, exit: WakePumpExit, turnError?: unknown): void {
  const arming = session.loop.arming;
  if (!arming) return;
  arming.ended = exit;
  arming.drain?.cancel();
  session.loop.arming = null;
  session.loop.turn = null;
  clearBusy(session);
  const takeover = arming.takeover;
  if (takeover) {
    logTurnTiming(session, takeover);
    if (turnError !== undefined) takeover.reject(turnError);
    else if (takeover.pushedAt === undefined) {
      // Reject an unpushed takeover so the executor's adopt-refused path retries fresh instead
      // of silently dropping the user's message.
      takeover.reject(
        new Error(
          `armIdle: arming ended (${exit.reason}) before the takeover turn started — adopt refused`,
        ),
      );
    } else takeover.resolve(); // pushed turn on interrupt/stream-end: graceful, like any turn end
  }
  arming.resolveDone(exit);
}

/**
 * Open a wake burst on the first frame after idle, and report whether the frame belongs to one.
 * False means ambient noise: it has no `result`, so opening a burst on it would leave the arming
 * mid-"burst" forever — and it must not keep the post-EOF reap at bay either, or a harness
 * chattering heartbeats would hold a wedged CLI open indefinitely.
 */
function openWakeBurst(msg: SDKMessage, arming: IdleArming): boolean {
  if (arming.phase !== 'idle') return true;
  if (isAmbientIdleFrame(msg)) return false;
  arming.drain?.noteBurst(msg);
  arming.phase = 'burst';
  arming.callbacks.onBurstStart();
  return true;
}

async function consumeTurnFrame(session: ClaudeSession, msg: SDKMessage): Promise<void> {
  const loop = session.loop;
  const turn = loop.turn;
  // Until its push a claimed session still reads as idle: a turn of the CLI's own retires it.
  if (turn?.path === 'warm' && turn.pushedAt === undefined) {
    const err = new Error(`runTurn: ${session.subChatId} was busy when claimed — adopt refused`);
    if (isIdleActivity(msg)) {
      session.retire('idle-activity');
      endTurn(session, err);
    }
    return;
  }
  if (loop.turn) noteTurnTiming(loop.turn, msg);
  try {
    await loop.turn?.onMessage(msg);
  } catch (err) {
    // A handler error on a NON-final message leaves the generator suspended mid-turn; realign to
    // the boundary so the next turn isn't fed this turn's tail. AT the boundary we are already
    // there — draining would await a value that only arrives after the next turn's push, which
    // would deadlock the session. A harness result is NOT the boundary, so it must still drain:
    // our turn's frames are all still ahead of it in the generator.
    if (!isTurnBoundary(msg)) await drainToResult(session, isTurnBoundary);
    if (loop.arming) endArming(session, { reason: 'turn-error', error: err }, err);
    else endTurn(session, err);
    return;
  }
  // Only OUR turn's result ends the wait — a harness turn's result can arrive first, and returning on
  // it would file that turn as the reply. A failed one rejects, as the one-shot SDK's query throws.
  if (!isTurnBoundary(msg)) return;
  const error = failedResultError(msg);
  if (!loop.arming) endTurn(session, error);
  else if (error) endArming(session, { reason: 'turn-error', error }, error);
  else endArming(session, { reason: 'turn-taken-over' });
}

async function consumeWakeFrame(
  session: ClaudeSession,
  arming: IdleArming,
  msg: SDKMessage,
): Promise<void> {
  if (!openWakeBurst(msg, arming)) return;
  try {
    await arming.callbacks.onMessage(msg);
    // A wake burst is the harness's own turn, so any result closes it.
    if (msg.type === 'result') await arming.callbacks.onBurstEnd(msg);
  } catch (err) {
    // A burst's own boundary is the harness result, so drain to ANY result here — isTurnBoundary
    // would skip straight past it and eat the frames of whatever the CLI does next.
    if (!isAnyResult(msg)) await drainToResult(session, isAnyResult);
    endArming(session, { reason: 'sink-error', error: err });
    return;
  }
  if (msg.type !== 'result') return;
  arming.phase = 'idle';
  arming.bursts += 1;
  if (arming.takeover) await pushTakeover(session, arming);
  // Evaluated strictly after the burst's own awaited duties (persist, signal) and only on a result
  // frame, so a burst parked on an unanswered question can never end the wait. Latched once.
  else settleIfWorkFinished(session, arming, () => clearBusy(session));
}

/** A sink threw where its own handler could not catch it (opening a burst, a realignment drain). */
function endRegistrationOnError(session: ClaudeSession, err: unknown): void {
  const { turn, arming } = session.loop;
  if (!arming) endTurn(session, err);
  else if (turn) endArming(session, { reason: 'turn-error', error: err }, err);
  else endArming(session, { reason: 'sink-error', error: err });
}

/** The generator threw or ended abnormally: nextTurnMessage already evicted the dead query, so the
 * registration that was reading ends with it. After the wait-over drain closed stdin, that end is
 * the CLI finishing the work we asked it to finish — not a stream death. */
function endOnReadFailure(session: ClaudeSession, err: unknown): void {
  const { turn, arming, closeExpected } = session.loop;
  // A claimed CLI that died before the model said anything never served the push: rerun it fresh.
  const unserved = turn?.path === 'warm' && turn.firstTokenAt === undefined;
  if (session.retained) session.retire('stream-ended');
  else if (unserved)
    endTurn(session, new Error('runTurn: claimed CLI died unserved — adopt refused'));
  else if (turn || !arming) endRegistrationOnError(session, err);
  else if (closeExpected) endArming(session, { reason: 'work-finished', bursts: arming.bursts });
  else endArming(session, { reason: 'stream-ended', error: err });
}

/** Route one read outcome to the registered sink. */
async function dispatchFrame(session: ClaudeSession, frame: SDKMessage | null): Promise<void> {
  const loop = session.loop;
  if (frame === null) {
    // A caller interrupt (plan halt, question park) ends the registration, not the session.
    if (loop.arming) endArming(session, { reason: 'interrupted' });
    else endTurn(session);
    return;
  }
  if (isSetterEcho(frame)) return;
  // Every frame is liveness: a single long burst (a wake turn running big tool calls) must keep
  // reading as attended, or the quiet-idle park sweep would park it mid-stream.
  session.lastActiveAt = Date.now();
  if (loop.turn) await consumeTurnFrame(session, frame);
  else if (loop.arming) await consumeWakeFrame(session, loop.arming, frame);
  // Idle, anything but a turn of the CLI's own is noise; that turn has no one to answer.
  else if (session.retained && isIdleActivity(frame)) session.retire('idle-activity');
}

async function readSessionStream(session: ClaudeSession): Promise<void> {
  const loop = session.loop;
  try {
    while (true) {
      if (!loop.turn && !loop.arming && !session.retained) {
        if (loop.stopped) break;
        await new Promise<void>((resolve) => {
          loop.wake = resolve;
        });
        continue;
      }
      let frame: SDKMessage | null;
      try {
        frame = await nextTurnMessage(session);
      } catch (err) {
        endOnReadFailure(session, err);
        break;
      }
      await dispatchFrame(session, frame);
    }
  } catch (err) {
    endRegistrationOnError(session, err);
  }
  loop.exited = true;
}
