/**
 * Predicates for frames the HARNESS produces rather than Frink — between-turn noise, and the results
 * of turns the CLI started for itself — plus the turn-boundary rule that distinction decides.
 *
 * Live beside the pump's other stream seams rather than inside the registry so the registry stays a
 * state machine and these stay testable rules about SDK frames.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * System frames the harness emits BETWEEN turns without a model turn following (task status
 * patches, progress heartbeats, state flips). They never end in a `result`, so opening a wake
 * burst on one would leave the pump mid-"burst" indefinitely — and a takeover push would defer
 * against a result that never comes. Dropped while idle; a real wake (task_notification → new
 * turn, or a cron's meta prompt turn) always carries turn frames that DO end in a result.
 */
const AMBIENT_IDLE_SUBTYPES = new Set([
  'task_updated',
  'task_progress',
  'task_started',
  'background_tasks_changed',
  'session_state_changed',
  'thinking_tokens',
]);

/**
 * A user-stopped task's notification is ambient too: a stopped shell or workflow wakes no turn at
 * all, and a stopped subagent's reaction turn opens its burst with its own frames.
 */
export function isAmbientIdleFrame(m: SDKMessage): boolean {
  if (m.type !== 'system') return false;
  if (m.subtype === 'task_notification') return m.status === 'stopped';
  return AMBIENT_IDLE_SUBTYPES.has(m.subtype);
}

/** The CLI's echo of a live setter: `setModel` answers with a `<local-command-stdout>` user frame
 * outside any turn. It is neither activity nor part of a reply. */
export function isSetterEcho(m: SDKMessage): boolean {
  const content = m.type === 'user' ? m.message?.content : undefined;
  return typeof content === 'string' && content.startsWith('<local-command-stdout>');
}

const TURN_FRAME_TYPES = new Set(['assistant', 'user', 'stream_event', 'result']);

/** A frame from an idle session that means the CLI started a turn of its own (a task notification,
 * a non-idle session state, or the model talking). Every other variant is status noise it survives. */
export function isIdleActivity(m: SDKMessage): boolean {
  if (TURN_FRAME_TYPES.has(m.type)) return true;
  if (m.type !== 'system') return false;
  if (m.subtype === 'session_state_changed') return m.state !== 'idle';
  return m.subtype === 'task_notification';
}

/**
 * A `result` ending a turn the HARNESS started, not one Frink pushed.
 *
 * The CLI runs turns of its own — a task notification it enqueued, or the `Continue from where you
 * left off.` continuation it injects after an interrupted turn — and stamps those prompts with an
 * `origin`. Frink's own pushes carry none. A turn loop that stops at the first `result` therefore
 * records the harness's turn as the reply to the user's message, and leaves the real reply unread in
 * the generator behind it.
 *
 * Negative match by design: an absent or `human` origin keeps the existing behaviour, so a frame
 * this does not recognise can only end a turn early — never hang one awaiting a result that the
 * harness was never going to send.
 */
function isHarnessTurnResult(m: SDKMessage): boolean {
  if (m.type !== 'result') return false;
  const kind = m.origin?.kind;
  return kind !== undefined && kind !== 'human';
}

/**
 * The end of a turn FRINK pushed. A `result` frame alone is not one — every place meaning "we are at
 * the end of our turn" must exclude the harness's own, or it stops early and leaves the real turn's
 * frames unread for the next caller to inherit.
 *
 * The wake pump's idle phase wants the opposite rule: a burst IS a harness turn, so there any
 * `result` closes it.
 */
export function isTurnBoundary(m: SDKMessage): boolean {
  return m.type === 'result' && !isHarnessTurnResult(m);
}

/** A WAKE BURST's boundary — the opposite of {@link isTurnBoundary}, since a burst IS a harness
 * turn. Passed explicitly so neither drain site can inherit the wrong rule silently. */
export function isAnyResult(m: SDKMessage): boolean {
  return m.type === 'result';
}
