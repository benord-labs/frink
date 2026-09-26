import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import {
  recordClaudeQueryStart,
  registerClaudeSessionSummaryReader,
} from '../diagnostics/provider-topology';
import { retireChannelToken, setChannelToken } from '../mcp/execution-identity';
import { captureMainMessage } from '../sentry/init';
import type { TaskStopHook } from '../task-stop-hook';
import type { ClaudeTurnContext } from './claude-turn-context';
import { diffKeyParts } from './execution/claude-session/session-key';
import {
  createSessionLoop,
  type SessionLoop,
  startSessionLoop,
  stopSessionLoop,
  watchRetainedSession,
} from './execution/claude-session-loop';
import { clearSubagentTasks } from './streaming/subagent-task-status';
import { createStreamingInputQueue, type StreamingInputQueue } from './streaming-input-queue';

/**
 * One persistent Claude `query()` per chat. Holding a single `query({ prompt:
 * queue.stream })` open across turns keeps the `claude` CLI subprocess — and its
 * MCP connections — warm, so slow stdio MCPs no longer re-lose the CLI's 5s
 * handshake race on every message. See
 * `docs/frink/todos/mcp-stdio-tools-stuck-pending.md`. Turn 1 pays the one-time
 * MCP cold start; turns 2..N reuse the warm clients (TUI/Codex-parity).
 */
export interface ClaudeSession {
  readonly subChatId: string;
  readonly query: Query;
  readonly queue: StreamingInputQueue;
  /** The Stop hook mounted at spawn: the one reader of this session's pending harness work. */
  readonly stopHook: TaskStopHook | null;
  /** The dynamic-chat channel token in this CLI's MCP URL, made current when the CLI spawns. */
  readonly channel?: string;
  /** One digest per option this CLI was spawned with. */
  readonly keyParts: Record<string, string>;
  /** The SDK conversation this CLI continues: its `resume` id until its stream announces one. */
  sdkSessionId: string;
  /** When its spawn's inputs (credential, MCP servers) were read, or earlier. */
  readonly inputsReadAt: number;
  /** Set while the session idles between turns: the only state a send can claim, or the idle
   * timer, the cap and the teardown sweeps retire. `prewarm` marks a CLI that never ran a turn. */
  retained: { since: number; timer: ReturnType<typeof setTimeout>; prewarm: boolean } | null;
  lastActiveAt: number;
  /** True while a turn or a wake arming is registered on the loop. One at a time per chat: the
   * query is a single shared generator, so overlapping registrations would split one turn's
   * messages across two sinks. `runTurn` rejects re-entry rather than corrupt. */
  busy: boolean;
  /** Set for one turn when the caller ends it on purpose (plan-submission halt, question park):
   * the resulting stream throw/end is a graceful turn boundary, not a dead query to evict. */
  interruptExpected: boolean;
  /** Resolves when the in-flight turn's `finally` has run (i.e. `busy` is cleared). Null when no
   * turn is running. A follow-up awaits it before replacing a busy leftover. */
  turnSettled: Promise<void> | null;
  /** The ACTIVE turn's state, read by the session's SDK callbacks (session-callbacks.ts). Null
   * means no turn is attached: they deny tools and Stop allows. */
  currentTurn: ClaudeTurnContext | null;
  /** Drop this session from the registry once its query is dead. Bound at creation so the reader
   * loop can evict without importing the registry back. */
  evict: () => void;
  /** End this idle session for good with one logged reason, bound like `evict`. */
  retire: (reason: string) => void;
  /** The session's one reader: turns and wake armings register their sinks here, and it is the
   * only caller of `query.next()`. */
  readonly loop: SessionLoop;
}

/** Builds the live `Query` from the persistent input stream. Injected by the executor
 * (it owns SDK options / credential resolution). Called once per chat, at session creation. */
export type CreateQuery = (prompt: AsyncIterable<SDKUserMessage>) => Query;

type SessionSpec = {
  stopHook?: TaskStopHook | null;
  channel?: string;
  keyParts?: Record<string, string>;
  sdkSessionId?: string;
  inputsReadAt?: number;
  /** The ref this session's callbacks were built with, bound to it as it is built: they resolve
   * through this session, never a successor registered under the same chat id. */
  ref?: { current: ClaudeSession | null };
};

/** How long a session idling between turns stays claimable. */
export const IDLE_TTL_MS = 10 * 60_000;
/** How long a pre-warmed CLI that never ran a turn waits for its chat's send. */
export const PREWARM_TTL_MS = 3 * 60_000;
/** Idle CLIs kept app-wide, at most the default Flow run cap. Retaining past it only evicts. */
export const MAX_RETAINED_CLAUDE_SESSIONS = 4;

// Module-level registry — one entry per open chat (mirrors the executor's per-subChat map idiom).
const sessions = new Map<string, ClaudeSession>();
/** The latest credential, MCP config or app-quit sweep: it also fences sessions not idle yet. */
let lastSweep = { at: 0, reason: '' };
/** Set by the app-quit sweep, for good: no pre-warm starts after it. */
let quitting = false;
/** The app's one pre-warm in flight: a send for its chat awaits its spawn, then claims its CLI. A
 * teardown of its chat while it spawns (`fence`) retires it as it lands. */
let prewarming: { subChatId: string; spawned: Promise<void>; fence?: string } | null = null;
/** Latest wins: the last pre-warm the one in flight turned away, run once that one lands. A
 * teardown of its chat drops it. */
let queuedPrewarm: { subChatId: string; run: () => Promise<unknown> } | null = null;
registerClaudeSessionSummaryReader(() => getClaudeSessionSummary());

export function getSession(subChatId: string): ClaudeSession | undefined {
  return sessions.get(subChatId);
}

/** Aggregate-only diagnostics; never exposes chat/session identity. */
function getClaudeSessionSummary(): { total: number; busy: number; retained: number } {
  let busy = 0;
  for (const session of sessions.values()) {
    if (session.busy) busy += 1;
  }
  return { total: sessions.size, busy, retained: retainedSessions().length };
}

function retainedSessions(): ClaudeSession[] {
  return [...sessions.values()].filter((session) => session.retained);
}

/** Spawn the chat's persistent query. A registered session belongs to a sibling execute, so this
 * refuses rather than share it: the caller's adopt-refused retry waits for that sibling to settle. */
export function createSession(
  subChatId: string,
  createQuery: CreateQuery,
  spec: SessionSpec = {},
): ClaudeSession {
  if (sessions.has(subChatId)) throw new Error('adopt refused: a sibling holds the chat session');
  const { stopHook = null, channel, keyParts = {}, sdkSessionId = '', ref } = spec;
  const { inputsReadAt = Date.now() } = spec;
  const queue = createStreamingInputQueue();
  const query = createQuery(queue.stream);
  recordClaudeQueryStart();
  // A new CLI's channel replaces its predecessor's, so a still-running older CLI resolves no run.
  if (channel) setChannelToken(subChatId, 'claude', channel);
  const session: ClaudeSession = {
    subChatId,
    queue,
    query,
    stopHook,
    channel,
    keyParts,
    sdkSessionId,
    inputsReadAt,
    retained: null,
    lastActiveAt: Date.now(),
    busy: false,
    interruptExpected: false,
    turnSettled: null,
    currentTurn: null,
    evict: () => evictIfCurrent(session),
    retire: (reason) => retireSession(session, reason),
    loop: createSessionLoop(),
  };
  if (ref) ref.current = session;
  sessions.set(subChatId, session);
  startSessionLoop(session);
  return session;
}

/** End a chat's session: closing the input stream lets the SDK finish and the CLI subprocess (with
 * its MCP children) exit. */
export function endSession(subChatId: string): void {
  const session = sessions.get(subChatId);
  if (!session) return;
  sessions.delete(subChatId);
  clearSubagentTasks(subChatId);
  stopSessionLoop(session);
  if (!session.queue.closed) session.queue.close();
}

/** Free the chat id for a spawn: wait out a busy sibling, orphan a draining one (its reader still
 * salvages late output), end anything else. */
export async function releaseLeftoverSession(subChatId: string): Promise<void> {
  let session = sessions.get(subChatId);
  if (session?.busy) {
    await session.turnSettled?.catch(() => {});
    session = sessions.get(subChatId);
  }
  if (!session || session.busy) return;
  if (session.loop.closeExpected) {
    captureMainMessage('draining session orphaned for a follow-up turn', 'warning', {
      surface: 'wake-pump-stand-down',
      subChatId,
    });
    unregisterSessionIfOwned(session);
  } else endSession(subChatId);
}

/**
 * Remove only the exact observed session from the registry. Deferred provider cleanup uses this
 * instead of {@link endSession} so an ABA successor registered under the same chat id stays live.
 */
export function unregisterSessionIfOwned(session: ClaudeSession): boolean {
  if (sessions.get(session.subChatId) !== session) return false;
  sessions.delete(session.subChatId);
  clearSubagentTasks(session.subChatId);
  return true;
}

/** End a session for good with one logged reason: its MCP channel retires with it and the CLI is
 * closed, not left to exit on stdin close. Identity-guarded, so a successor stays registered. */
function retireSession(session: ClaudeSession, reason: string): void {
  // Already retired, or evicted dead: a late caller (a refused reconcile) must not log it again.
  if (!session.retained && sessions.get(session.subChatId) !== session) return;
  const prewarm = session.retained?.prewarm ? ' prewarm' : '';
  if (session.retained) clearTimeout(session.retained.timer);
  session.retained = null;
  evictIfCurrent(session);
  retireChannelToken(session.channel);
  session.query.close();
  log.info(`[Claude Session] retire sub=${session.subChatId} reason=${reason}${prewarm}`);
}

/** Retire the chat's session if it is idling between turns, and stop its pending pre-warm (chat
 * delete/archive, provider switch). */
export function retireRetainedSession(subChatId: string, reason: string): void {
  if (prewarming?.subChatId === subChatId) prewarming.fence = reason;
  if (queuedPrewarm?.subChatId === subChatId) queuedPrewarm = null;
  const session = sessions.get(subChatId);
  if (session?.retained) retireSession(session, reason);
}

/** Retire every session idling between turns (credential or MCP config change, app quit). */
export function retireRetainedSessions(reason: string): void {
  lastSweep = { at: Date.now(), reason };
  quitting ||= reason === 'app-quit';
  for (const session of retainedSessions()) retireSession(session, reason);
}

/** Keep a session idle for the chat's next send: a clean turn end, or a `prewarm` spawned before
 * any. It holds no turn, so its callbacks deny tools, and its reader retires it on any activity. */
export function retainSession(session: ClaudeSession, { prewarm = false } = {}): void {
  // A sweep or chat teardown since its inputs were read skipped it (busy, held, not yet spawned).
  const fence = prewarm && prewarming?.subChatId === session.subChatId ? prewarming.fence : '';
  const swept = session.inputsReadAt <= lastSweep.at ? lastSweep.reason : fence;
  if (swept || session.loop.exited) {
    retireSession(session, swept || 'stream-ended');
    return;
  }
  const retained = {
    since: Date.now(),
    prewarm,
    timer: setTimeout(
      () => {
        if (session.retained === retained && sessions.get(session.subChatId) === session) {
          retireSession(session, 'idle-ttl');
        }
      },
      prewarm ? PREWARM_TTL_MS : IDLE_TTL_MS,
    ),
  };
  retained.timer.unref();
  session.retained = retained;
  session.currentTurn = null;
  evictOverCap(session);
  if (session.retained === retained) watchRetainedSession(session);
}

/** Keep the cap, retiring unused pre-warms first, then the longest idle. Only idle sessions count,
 * so a busy, held, draining or spawning one is never evicted. */
function evictOverCap(session: ClaudeSession): void {
  const others = retainedSessions().filter((other) => other !== session);
  const rank = (other: ClaudeSession) => (other.retained?.prewarm ? 0 : 1);
  others.sort((a, b) => rank(a) - rank(b) || (a.retained?.since ?? 0) - (b.retained?.since ?? 0));
  const overCap = others.length + 1 - MAX_RETAINED_CLAUDE_SESSIONS;
  // A pre-warm retires every older pre-warm but the newest, cap or not: browsing idles two CLIs, and
  // two chats opened in turn keep theirs. It never evicts a session that ran a turn; it gives way.
  const prewarm = session.retained?.prewarm;
  const evictable = prewarm
    ? others.filter((other) => other.retained?.prewarm).slice(0, -1)
    : others;
  if (overCap > evictable.length) {
    retireSession(session, 'idle-cap');
    return;
  }
  const evicted = prewarm ? evictable : evictable.slice(0, Math.max(0, overCap));
  for (const other of evicted) retireSession(other, 'idle-cap');
}

/** Why the chat's CLI cannot be pre-warmed now: never once the app quits, over a live or spawning
 * CLI, while another chat pre-warms, or where keeping it would evict what a pre-warm may not. */
export function prewarmBlocker(subChatId: string): string | null {
  if (quitting) return 'quitting';
  if (sessions.has(subChatId) || prewarming?.subChatId === subChatId) return 'session';
  if (prewarming) return 'in-flight';
  const retained = retainedSessions();
  const used = retained.filter((session) => !session.retained?.prewarm).length;
  // Kept from a new pre-warm: every session that ran a turn, and the newest pre-warm.
  return Math.min(retained.length, used + 1) >= MAX_RETAINED_CLAUDE_SESSIONS ? 'cap-full' : null;
}

/** Queue a pre-warm the one in flight turned away, replacing any queued before it. */
export function queuePrewarm(subChatId: string, run: () => Promise<unknown>): void {
  queuedPrewarm = { subChatId, run };
}

/** Take the queued pre-warm, to run once the one in flight lands. */
export function takeQueuedPrewarm(): (() => Promise<unknown>) | undefined {
  const next = queuedPrewarm;
  queuedPrewarm = null;
  return next?.run;
}

/** Run the app's one pre-warm, holding it until `spawn` resolves to its outcome (never rejects):
 * once its CLI's MCP servers are up. A send for its chat waits only until `spawn` calls `spawned`. */
export function runPrewarm(
  subChatId: string,
  spawn: (spawned: () => void) => Promise<string>,
): Promise<string> {
  let markSpawned = () => {};
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  prewarming = { subChatId, spawned };
  return spawn(markSpawned).finally(() => {
    markSpawned();
    prewarming = null;
  });
}

/** Wait out a pre-warm spawning this chat's CLI, so the send claims it instead of spawning. */
export async function settlePrewarm(subChatId: string): Promise<void> {
  if (prewarming?.subChatId === subChatId) await prewarming.spawned;
}

type ClaimRequest = {
  keyParts: Record<string, string>;
  /** The conversation the send continues: sub_chats.session_id, empty after a rollback. */
  persistedSessionId: string | undefined;
  flowTurn: boolean;
};

/** Why a retained session cannot serve this send, or null when it can. */
function claimMiss(
  session: ClaudeSession,
  { since, prewarm }: NonNullable<ClaudeSession['retained']>,
  request: ClaimRequest,
): string | null {
  if (request.flowTurn) return 'flow-turn';
  const changed = diffKeyParts(session.keyParts, request.keyParts);
  if (changed.length > 0) return `key-mismatch:${changed.join(',')}`;
  // A pre-warm that never ran a turn serves a send that starts its conversation, too.
  const conversation = request.persistedSessionId || (prewarm ? '' : null);
  if (conversation === null || session.sdkSessionId !== conversation) {
    return 'conversation-mismatch';
  }
  if (Date.now() - since >= (prewarm ? PREWARM_TTL_MS : IDLE_TTL_MS)) return 'expired';
  if (session.loop.exited || session.queue.closed) return 'stream-ended';
  return null;
}

/** Hand the chat's idle session to a send, or retire it with why it cannot (part names only).
 * Checks and hand-off are one synchronous span; the caller extends it until runTurn takes busy. */
export function claimRetainedSession(
  subChatId: string,
  request: ClaimRequest,
): ClaudeSession | { miss: string } {
  const session = sessions.get(subChatId);
  const retained = session?.retained;
  const miss = session && retained ? claimMiss(session, retained, request) : 'none';
  const prewarm = retained?.prewarm ? ' prewarm' : '';
  log.info(`[Claude Session] claim sub=${subChatId} ${miss ? `miss:${miss}` : 'hit'}${prewarm}`);
  if (!session || !retained) return { miss: 'none' };
  if (miss) {
    retireSession(session, miss);
    return { miss };
  }
  clearTimeout(retained.timer);
  session.retained = null;
  return session;
}

/** Close the session (the SDK's forceful end) and retire its MCP channel token when its owning
 * execute aborts. The unbind stops a later abort from closing a session another turn took over. */
export function bindTurnAbort(session: ClaudeSession, signal: AbortSignal): () => void {
  const close = () => {
    retireChannelToken(session.channel);
    session.query.close();
  };
  if (signal.aborted) close();
  else signal.addEventListener('abort', close, { once: true });
  return () => signal.removeEventListener('abort', close);
}

/** Self-eviction from a possibly-stale in-flight turn. Identity-guarded: if the chat was
 * closed and reopened under the same id while this turn ran, a NEWER session now holds the
 * key — a plain `endSession(id)` would delete that innocent session (ABA). Only evict when
 * this exact session is still the registered one. */
function evictIfCurrent(session: ClaudeSession): void {
  if (sessions.get(session.subChatId) === session) endSession(session.subChatId);
}

/** True for an 'adopt refused' rejection: a dead or ended wake arming, an unpushed takeover, or a
 * sibling that registered the chat's session first. Nothing streamed, so a rerun is safe. */
export function isPumpAdoptRefusedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('adopt refused');
}

/** Test-only: drop all sessions so test order doesn't matter, releasing each session's parked
 * reader. Queues stay open — fake queries in tests have no process to end. */
export function __resetSessionsForTest(): void {
  for (const session of sessions.values()) {
    if (session.retained) clearTimeout(session.retained.timer);
    stopSessionLoop(session);
  }
  sessions.clear();
  lastSweep = { at: 0, reason: '' };
  quitting = false;
  prewarming = null;
  queuedPrewarm = null;
}
