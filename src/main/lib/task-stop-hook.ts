/**
 * Factory for the Stop hook that enforces frink_task_signal invocation.
 *
 * Extracted from the inline closures in claude.ts and executor.ts so the
 * logic is testable in isolation and shared across execution paths.
 *
 * The returned async function matches the Claude SDK Stop hook signature.
 * Pass it directly to `options.hooks.Stop[].hooks[]`.
 */

import type { BackgroundTaskSummary, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';

const STOP_HOOK_BLOCK_REASON =
  'You stopped without calling frink_task_signal. If this step is genuinely finished, blocked, or needs user input, call frink_task_signal now with the appropriate state (done, awaiting_input, blocked, partial, or failed) and a concise summary. If you are intentionally waiting on still-running background work (subagents, monitors, long commands), do NOT signal a premature or false state — keep waiting and check on that work instead.';

/** Harness work still in flight when the model stopped — backgrounded tasks (shell, subagents,
 * monitors) plus session crons (ScheduleWakeup). Non-null only when at least one exists. */
export interface StopPendingWork {
  backgroundTasks: NonNullable<StopHookInput['background_tasks']>;
  sessionCrons: NonNullable<StopHookInput['session_crons']>;
}

const TAIL_COMMAND = /\btail\b/;
const FOLLOW_FLAG = /(?:\s-[a-zA-Z]*[fF]\b|\s--follow\b)/;
/**
 * Anything that can leave a SECOND command running once the tail is discounted: `&` backgrounds, `;`
 * and `||` sequence, `&&` is built from `&`. A command containing one is never judged — the rule can
 * only reason about the tail, and dropping a task whose other half is still working would end the
 * wait under live work. A bare `|` is deliberately absent: a pipeline is ONE unit whose life is its
 * head's, since every consumer exits when its stdin closes.
 *
 * Redirection and substitution are NOT disqualifying — neither outlives the tail, and a quoted `>`
 * inside a grep pattern is ordinary in the commands this exists to catch.
 */
const CHAINS_ANOTHER_COMMAND = /[&;\n]|\|\|/;
/** Session ids are opaque; anything outside this alphabet cannot be interpolated into a pattern. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Matcher for THIS session's background-task output files, which the harness writes to
 * `<sandbox>/<session-id>/tasks/<taskId>.output`.
 *
 * Anchoring on the session id is what makes the read a fact rather than a guess: a repo with a
 * directory of its own called `tasks/` would otherwise collide, and a live `tail -f tasks/build.output`
 * would be mistaken for a finished harness task and dropped. Null for a session id that cannot be
 * anchored safely, which disables the whole rule rather than guessing.
 */
function taskOutputMatcher(sessionId: string): RegExp | null {
  if (!SAFE_SESSION_ID.test(sessionId)) return null;
  return new RegExp(`/${sessionId}/tasks/([A-Za-z0-9_-]+)\\.output\\b`, 'g');
}

/** Task ids whose output file this path names. Empty for anything that is not a task output. */
function referencedTaskIds(text: string, taskOutput: RegExp): string[] {
  return [...text.matchAll(taskOutput)].map(([, id]) => id);
}

/** True when the segment follows its input forever (`tail -f`, `-F`, `--follow`) rather than reading
 * to EOF and exiting. A reader that exits on its own is never a dead follower — it leaves the task
 * list without help. */
function followsForever(segment: string): boolean {
  return TAIL_COMMAND.test(segment) && FOLLOW_FLAG.test(segment);
}

/**
 * Is this ONE command watching only tasks that are gone?
 *
 * Correlation is the whole point: the follow flag and the task-output path must belong to the SAME
 * command, or `tail -f /var/log/app.log & cat …/tasks/old.output` reads as a dead follower while its
 * real target is an unrelated live log. Every path it names must be a task output — one token this
 * rule cannot account for (any other file, still being written) makes it unjudgeable, so the command
 * counts as live.
 */
function watchesOnlyFinishedTasks(
  command: string,
  ownId: string,
  liveTaskIds: ReadonlySet<string>,
  taskOutput: RegExp,
): boolean {
  const paths = command.split(/\s+/).filter((token) => token.includes('/'));
  if (paths.length === 0) return false;
  const watched: string[] = [];
  for (const path of paths) {
    const [id] = referencedTaskIds(path, taskOutput);
    if (!id) return false;
    if (id !== ownId) watched.push(id);
  }
  return watched.length > 0 && watched.every((id) => !liveTaskIds.has(id));
}

/**
 * A task whose only job was to watch other tasks that have since finished.
 *
 * Agents reach for `tail -f <other-task>.output | grep …` to narrate a long run, and `tail -f` never
 * exits — so once the run it watched ends, the follower stays `running` in `background_tasks`
 * forever and keeps the whole chat waiting on nothing. This is not a status guess: the command names
 * the task ids it follows, and the harness's own list says whether those tasks still exist.
 *
 * Recognises ONE shape and keeps everything else: a single pipeline whose head follows this session's
 * finished task outputs. Shell offers more ways to stay alive than a pattern can enumerate, so the
 * unknown case must be "still working" — a missed follower costs the wait it already cost, while a
 * wrongly dropped one ends a wait under live work.
 */
function isDeadFollower(
  task: BackgroundTaskSummary,
  liveTaskIds: ReadonlySet<string>,
  taskOutput: RegExp,
): boolean {
  if (task.type !== 'shell' || !task.command) return false;
  if (CHAINS_ANOTHER_COMMAND.test(task.command)) return false;
  const [head] = task.command.split('|');
  if (!head || !followsForever(head)) return false;
  return watchesOnlyFinishedTasks(head, task.id, liveTaskIds, taskOutput);
}

function readPendingWork(input: StopHookInput): StopPendingWork | null {
  const reported = input.background_tasks ?? [];
  const liveTaskIds = new Set(reported.map((task) => task.id));
  const taskOutput = taskOutputMatcher(input.session_id);
  const backgroundTasks = taskOutput
    ? reported.filter((task) => !isDeadFollower(task, liveTaskIds, taskOutput))
    : reported;
  // Dropping a task can end the chat's wait, so never do it silently — a misjudged command would
  // otherwise leave no trace of why the session stopped waiting for it.
  for (const task of reported) {
    if (!backgroundTasks.includes(task)) {
      log.info(`[Stop hook] Ignoring finished follower ${task.id}: ${task.command?.slice(0, 200)}`);
    }
  }
  const sessionCrons = input.session_crons ?? [];
  if (backgroundTasks.length === 0 && sessionCrons.length === 0) return null;
  return { backgroundTasks, sessionCrons };
}

type TaskStopHookOpts = {
  /**
   * Returns true when frink_task_signal has already been called for this turn.
   * May be async (e.g. executor.ts reads from dynamic-chat-server via dynamic import).
   */
  hasSignal: () => boolean | PromiseLike<boolean>;
  /** Returns true when the execution abort controller has been triggered. */
  isAborted: () => boolean;
  /**
   * Maximum number of forced-continuation retries before the hook allows the agent
   * to stop regardless of signal state. Prevents infinite continuation loops.
   * Defaults to 2 (agent gets at most 2 extra turns to call the signal).
   */
  maxRetries?: number;
  /**
   * Fired on every allow — i.e. whenever the turn actually ends (after any forced
   * frink_task_signal round-trip). The executor's turn-end duty here is the quiet-end mark, which
   * doubles as the park sweep's inactivity timestamp: a pending-work allow marks it too, and each
   * wake turn's own stop refreshes it, so the 45-min park only ever catches a dead wake pipeline.
   * NOT fired on `block` (the turn continues). AWAITED before the allow is returned, so any write
   * it performs is ordered before the turn ends. Best-effort; must not throw.
   */
  onAllow?: () => void | Promise<void>;
};

/**
 * `decision: 'block'` produces a blockingError in the SDK, which is injected
 * as a user message the model sees on the next turn. This is the only mechanism
 * that actually forces the agent to continue — `systemMessage` becomes a
 * `hook_system_message` attachment that is excluded from API messages and never
 * reaches the model. An empty object `{}` allows the agent to stop.
 */
type StopHookResult = { decision: 'block'; reason: string } | Record<string, never>;

/**
 * Creates a Stop hook function that guards frink_task_signal invocation.
 *
 * Behaviour:
 *  - If the execution was aborted → allow stop immediately (never force-continue an aborted run)
 *  - If harness work is pending (background tasks / session crons) → allow WITHOUT coercing a
 *    signal and WITHOUT consuming a retry: the model is legitimately waiting on a machine and
 *    the harness will wake it when the work settles. The caller reads
 *    {@link TaskStopHook.lastPendingWork} to keep the session alive for that wake.
 *  - If the signal was already called → allow stop
 *  - If retries exhausted → allow stop (prevents infinite loop)
 *  - Otherwise → block with a MANDATORY reason message (consumes one retry)
 */
/** The Stop hook, plus a {@link TaskStopHook.reset} that restores its retry budget when a new turn
 * adopts a held session (every spawn, retries included, builds a fresh hook).
 * {@link TaskStopHook.lastPendingWork} exposes the most recent Stop's in-flight harness work so the
 * executor can arm the between-turn wake pump and block idle eviction. */
export type TaskStopHook = ((input: StopHookInput) => Promise<StopHookResult>) & {
  reset: () => void;
  lastPendingWork: StopPendingWork | null;
  /** The last Stop dropped a finished follower that is still running: only the CLI's EOF ends it. */
  droppedFollower?: boolean;
  /** A Stop ran since the hook was built or last reset, so its snapshot is the current turn's. */
  stoppedSinceReset?: boolean;
};

export function createTaskStopHook(opts: TaskStopHookOpts): TaskStopHook {
  const maxRetries = opts.maxRetries ?? 2;
  let retries = 0;

  // Funnel every idle allow through here so onAllow (turn-end duties) can never be forgotten
  // on a new allow path, and so it fires exactly once per allow decision.
  const allow = async (): Promise<Record<string, never>> => {
    await opts.onAllow?.();
    return {};
  };

  const hook = (async (input: StopHookInput): Promise<StopHookResult> => {
    hook.stoppedSinceReset = true;
    hook.lastPendingWork = readPendingWork(input);
    hook.droppedFollower =
      (input.background_tasks?.length ?? 0) > (hook.lastPendingWork?.backgroundTasks.length ?? 0);
    if (opts.isAborted()) {
      return allow();
    }
    // A stop with harness work in flight is a machine wait: never coerce a signal (the model is
    // legitimately waiting; a forced continuation just burns tokens) and consume no retry. The
    // allow still runs onAllow — its quiet-end mark is the park sweep's inactivity timestamp, and
    // every wake turn's own stop refreshes it, so only a DEAD wake pipeline ever reaches the
    // ceiling (see flow-quiet-wait-handling).
    if (hook.lastPendingWork) {
      return allow();
    }
    if (retries >= maxRetries) {
      return allow();
    }

    const hasSignalResult = await Promise.resolve(opts.hasSignal());

    if (opts.isAborted()) {
      return allow();
    }
    if (retries >= maxRetries) {
      return allow();
    }
    if (hasSignalResult) {
      return allow();
    }

    retries++;
    return {
      decision: 'block',
      reason: STOP_HOOK_BLOCK_REASON,
    };
  }) as TaskStopHook;
  hook.lastPendingWork = null;
  hook.reset = (): void => {
    retries = 0;
    hook.lastPendingWork = null;
    hook.droppedFollower = false;
    hook.stoppedSinceReset = false;
  };
  return hook;
}
