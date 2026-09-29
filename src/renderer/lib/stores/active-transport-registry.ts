/**
 * Liveness registry for in-flight chat streams.
 *
 * A subChatId is "live" while its WebSocketChatTransport has an open stream listener registered
 * here (set in sendMessages' start(), removed on finalize/error/disconnect/abort). This is a
 * dependency-free singleton on purpose: the transport module pulls in trpc/Sentry at load, so
 * lightweight readers — e.g. getToolStatus deciding whether a subagent card is still running —
 * read liveness from here instead, without dragging those heavy deps into UI leaf modules.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { WakeHoldState } from '../../../shared/types/wake-hold';

/**
 * subChatId → listener cleanup fn (`closeStream` also closes the owned stream on teardown). The
 * transport owns mutation; readers use hasActiveTransport.
 *
 * CONTRACT for writers: because readers (getToolStatus) read this Map non-reactively during render,
 * every `activeListeners.delete(subChatId)` MUST be accompanied by a re-render trigger for any
 * still-mounted card — normally a `setStatus(subChatId, 'ready')` (or equivalent chatStatus change)
 * at the same site, or the stream close / card unmount on the chat-delete & abort teardown paths.
 * Without one, a bare delete strands a spinner on a dead run (the non-reactive read never re-runs).
 */
export const activeListeners = new Map<string, (closeStream?: boolean) => void>();

/**
 * True while we have an active stream listener for this subChatId (we initiated the request and the
 * run is still live). Used to avoid duplicate message handling and to stop the UI from showing a
 * dead run as still-running after a server/main-process restart.
 */
export function hasActiveTransport(subChatId: string): boolean {
  return activeListeners.has(subChatId);
}

/**
 * The other half of liveness: a run streaming in the main process that NO local transport owns — a
 * between-turn wake burst (the agent woke itself on background work after the turn that started it
 * already finished).
 *
 * Separate from {@link hasActiveTransport} because that answers "did this window start the run",
 * which the observer lane needs to keep answering `false` so it doesn't fight the transport.
 *
 * An atom rather than another entry in the Map above precisely so it can be SUBSCRIBED to:
 * `MessageSyncManager` reads it with `useAtomValue` and passes it into `getEffectiveStatus`, so
 * both of its effects re-run on a flip. That matters because one of them feeds the
 * queue-processor's dispatch gate, and useChat's own `status` does not change across a wake burst
 * — an imperative read there would sit stale for the burst's whole life and let the queue dispatch
 * on top of it. Unlike the Map above, this needs no hand-paired re-render.
 */
export const observedRunAtomFamily = atomFamily((_subChatId: string) => atom<boolean>(false));

/** Main's run liveness for a sub-chat, UNMASKED by transport ownership (execute-start → settle/error,
 * whoever started it). Terminal task writes key on this, not on the multi-writer status store. */
export const runLiveAtomFamily = atomFamily((_subChatId: string) => atom<boolean>(false));

/** Main has completed every run it still holds for a sub-chat and is only settling them
 * (execute-complete → stream-settled): nothing is left to steer. */
export const runSettlingAtomFamily = atomFamily((_subChatId: string) => atom<boolean>(false));

/**
 * The third liveness state: the session is held open waiting on background work — a backgrounded
 * command, a Monitor, a ScheduleWakeup cron — and WILL wake again on its own.
 *
 * Neither of the two above covers it. Between wake bursts there is no transport, no observed run,
 * and status is 'ready' — byte-identical to a finished turn. This flag is what lets the
 * BackgroundWaitRow advertise the wait, the plan card hide Approve, and PendingQuestionsManager
 * keep a held question answerable across burst boundaries.
 *
 * Declared by the producer (main broadcasts 'socket:wake-hold-changed' from the wake pump's own
 * arm/release paths), never inferred here — a burst is otherwise invisible to the renderer, and
 * guessing from message shape misreads flow chat_reply rows and retried turns.
 *
 * Nothing is persisted, but a reload does NOT lose the wait: `useWakeHoldSync` re-seeds this on boot
 * from main's live registry (`socket.listWakeHolds`), which is the only record either process keeps.
 * This once deliberately rendered a reloaded chat as finished, on the reasoning that a "waiting"
 * badge nothing could retract was worse. That reasoning was wrong — retractions broadcast to EVERY
 * window, so a reloaded one has always been able to clear the badge — and the cost was real: a held
 * chat with no BackgroundWaitRow has no Stop at all, since the composer's is gated on isStreaming.
 *
 * Null means not held. The value doubles as the wait's detail (what it is blocked on, as of the
 * last wake) so the two can never disagree about whether a wait is on.
 */
export const wakeHeldAtomFamily = atomFamily((_subChatId: string) =>
  atom<WakeHoldState | null>(null),
);

/** Held subChatId → its chatId, so chat-level surfaces (the sidebar) can show the wait. Written only
 * by `useWakeHoldSync`, alongside {@link wakeHeldAtomFamily}. */
export const heldSubChatsAtom = atom<ReadonlyMap<string, string>>(new Map<string, string>());
export const heldChatIdsAtom = atom((get) => new Set(get(heldSubChatsAtom).values()));

/** True while a follow-up turn runs on an adopted hold, so its Stop also ends the background work.
 * Set by an 'adopted' retraction; cleared by the sub-chat's next wake-hold frame or turn finish. */
export const wakeHoldAdoptedAtomFamily = atomFamily((_subChatId: string) => atom<boolean>(false));

/**
 * The fourth liveness state: tool-call ids of background SUBAGENTS currently running, fed by
 * 'socket:subagent-task-changed' (main's task-frame tracker). An async Agent launch resolves its
 * tool part immediately, so part state alone reads "Completed Subagent" while the task runs —
 * the Task card ORs this in. One Set-valued atom, not an atomFamily keyed by toolCallId: the
 * running set is tiny and bounded, while per-toolCallId family keys would accrete for the process
 * lifetime. In-memory only, same trade as the hold flag above.
 */
export const runningSubagentToolIdsAtom = atom<ReadonlySet<string>>(new Set<string>());
