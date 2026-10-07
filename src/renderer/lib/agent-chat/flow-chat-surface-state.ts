/**
 * Pure state derivations for the flow-chat bottom surface (decision flow-run-chat-surface):
 * while a flow run actively drives the sub-chat, the composer is replaced by a state-matched
 * surface — a running strip (Pause/Stop/add-a-note), the paused bar (reply + Resume + Stop), or
 * the park answer surface.
 *
 * Three inputs, three jobs. The LIVE RUN supplies liveness and identity: it exists through the
 * taskless windows (between two agent nodes, while a non-agent node runs, before the first task)
 * that no task row can represent. The DRIVING TASK picks WHICH surface — never liveness, and never
 * raw flow_run status, which is ambiguous about intent (a `paused` run can mean "actively working
 * the next node"). The SUB-CHAT MODE supplies the readout's mode, which neither of the other two can
 * report once a node changes mode mid-turn (see readTaskAgentInfo). Non-flow chats and terminal runs
 * always get the normal composer.
 */

import { isRetryableParkedResult } from '../../../shared/lib/task-retry-policy';
import { type ResolvedTaskStartMode, toChatMode } from '../../../shared/lib/trigger-rule-config';
import type { ChatMode } from '../../../shared/types/chat-mode';
import { type CodexSpeed, isCodexSpeed } from '../../../shared/types/execution';
import type { AgentUserQuestion } from '../../../shared/types/task-signal';
import { taskResultSchema, type TaskResultRecord } from '../../../shared/types/task-result';

type ParkedTask =
  | {
      status?: string;
      result?: TaskResultRecord | null;
      /** The tRPC-delivered flow config (`triggerContext.Config`) — carries model + mode. */
      triggerContext?: TaskResultRecord | null;
    }
  | null
  | undefined;

/** The live flow run driving the sub-chat (`tasks.getDrivingTaskForSubChat` → `run`). */
type ActiveRunRef = { id: string } | null | undefined;

/**
 * Every part of that query, as the bottom surface consumes them. `subChatMode` is the chat's LIVE
 * mode — the task rows carry only what was dispatched.
 */
type FlowChatSurfaceData =
  | { run: ActiveRunRef; task: ParkedTask; subChatMode?: ChatMode | null }
  | null
  | undefined;

/**
 * Shown when a park carries no prose of its own. An agent signal is free to arrive without a
 * summary (a bare `blocked`/`partial`), and a reply box with no prompt line above it is the
 * stranding flow-park-answer-surface exists to prevent — so the reply state always resolves to an
 * ask, and no consumer has to remember to supply one.
 */
const DEFAULT_PARK_ASK = 'The agent needs your input to continue.';

export type ParkSurfaceState =
  | { kind: 'none' }
  | { kind: 'questions'; questions: AgentUserQuestion[] }
  | { kind: 'reply'; summary: string };

/** True when the driving task was parked by the chat Pause button (result.userPause marker). */
function hasUserPauseMarker(result: TaskResultRecord | null | undefined): boolean {
  return Boolean(result?.userPause);
}

function configRecord(
  triggerContext: TaskResultRecord | null | undefined,
): TaskResultRecord | null {
  // The tRPC camelCase middleware rewrites SQLite's `_config` key to the renderer's canonical
  // `Config` transport shape.
  const config = triggerContext?.Config;
  const parsed = taskResultSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

function readTaskAgentInfo(
  task: ParkedTask,
  liveMode: ChatMode | null | undefined,
): {
  modelId?: string;
  mode?: ChatMode;
  autoReviewTools?: boolean;
  codexSpeed?: CodexSpeed;
} {
  if (!task) return {};
  const config = configRecord(task.triggerContext);
  const result = task.result ?? null;
  const model = config?.model ?? result?.model;
  const startMode = result?.startMode ?? config?.startMode;
  // Auto consent comes from `Config`: tRPC transports what the flow dispatcher wrote at creation,
  // so it reports what the FLOW asked for over the whole run. The chat's own seeded Auto setting is the
  // value that actually governs each turn; the two agree unless a human has since changed it.
  const autoReviewTools = config?.autoReviewTools;
  const codexSpeed = config?.codexSpeed;
  return {
    modelId: typeof model === 'string' ? model : undefined,
    mode:
      liveMode ??
      (typeof startMode === 'string' ? toChatMode(startMode as ResolvedTaskStartMode) : 'agent'),
    autoReviewTools: typeof autoReviewTools === 'boolean' ? autoReviewTools : undefined,
    codexSpeed: isCodexSpeed(codexSpeed) ? codexSpeed : undefined,
  };
}

/**
 * Which park answer surface a parked driving task should render: structured `questions` get the
 * clickable card; every OTHER user-input park gets a summary + free-text reply box, so no park is
 * ever left without an in-chat answer affordance. Two carve-outs return `none`: transient parks
 * (usage limit / API error — TaskControls owns their Continue / Retry) and user-pause parks
 * (the paused bar owns those).
 */
export function deriveParkSurfaceState(task: ParkedTask): ParkSurfaceState {
  const record = task?.result ?? null;
  if (task?.status !== 'needs_attention' || isRetryableParkedResult(record)) {
    return { kind: 'none' };
  }
  if (record?.userPause) {
    return { kind: 'none' };
  }
  const agentSignal = record?.agentSignal as
    | { state?: string; summary?: string; questions?: AgentUserQuestion[] }
    | undefined;
  if (agentSignal?.state === 'awaiting_input' && agentSignal.questions?.length) {
    return { kind: 'questions', questions: agentSignal.questions };
  }
  const summary = agentSignal?.summary?.trim() ? agentSignal.summary : DEFAULT_PARK_ASK;
  return { kind: 'reply', summary };
}

export type FlowChatBottomSurface =
  | { kind: 'composer' }
  | {
      kind: 'running';
      flowRunId: string;
      canPause: boolean;
      modelId?: string;
      mode?: ChatMode;
      autoReviewTools?: boolean;
      codexSpeed?: CodexSpeed;
    }
  | {
      kind: 'paused';
      flowRunId: string;
      modelId?: string;
      mode?: ChatMode;
      autoReviewTools?: boolean;
      codexSpeed?: CodexSpeed;
    }
  | { kind: 'park' };

export function deriveFlowChatBottomSurface(data: FlowChatSurfaceData): FlowChatBottomSurface {
  const { run, task, subChatMode } = data ?? {};
  // Liveness is a RUN fact, never a task fact: a live run passes through taskless windows where no
  // task row exists to carry it.
  if (!run) return { kind: 'composer' };
  if (task?.status === 'needs_attention') {
    if (hasUserPauseMarker(task.result)) {
      return { kind: 'paused', flowRunId: run.id, ...readTaskAgentInfo(task, subChatMode) };
    }
    // Transient parks derive to 'none' — those keep the composer (TaskControls owns their
    // Continue / Retry), so the chat is never left input-less.
    return deriveParkSurfaceState(task).kind === 'none' ? { kind: 'composer' } : { kind: 'park' };
  }
  // States that own a recovery/approval affordance elsewhere, which the strip must not hide: the
  // plan card approves plan_ready; TaskControls owns failed (Continue / Retry); a restart-interrupted
  // run resumes via a chat reply + InterruptedRunControls (decision flow-run-restart-recovery) and
  // reaches here LIVE, because the boot sweep cancels the TASK while its flow_run stays `paused`.
  if (task?.status === 'plan_ready' || task?.status === 'failed' || task?.status === 'cancelled') {
    return { kind: 'composer' };
  }
  // Everything else under a live run is the run working: pending/running, the terminal task of the
  // node that just finished, and `task == null` — the taskless window.
  //
  // Pause is offered only where parkFlowTaskForSubChat can act (it selects tasks.status = 'running'):
  // the taskless windows — a non-agent node or the gap between agent nodes — leave nothing parkable.
  return {
    kind: 'running',
    flowRunId: run.id,
    canPause: task?.status === 'running',
    ...readTaskAgentInfo(task, subChatMode),
  };
}

/**
 * Poll policy for the query feeding the bottom surface. Keyed off RUN LIVENESS, never off the derived
 * surface: a live run must keep polling even while it shows the composer (a transient park, a plan
 * gate) or crosses a taskless window, or the query switches itself off mid-run and the surface
 * freezes until an unrelated invalidation. Fast while the strip tracks the current node, the parked
 * cadence otherwise. `false` only with NO live run — a terminal run or a non-flow chat, where
 * invalidations keep things fresh — except a parked task, which ParkAnswerSurface still needs polled.
 */
export function getFlowSurfaceRefetchInterval(data: FlowChatSurfaceData): number | false {
  if (data?.run) {
    return deriveFlowChatBottomSurface(data).kind === 'running' ? 3500 : 5000;
  }
  // `cancelled` joins `needs_attention` as a poll-worthy dead state. A restart-interrupted run is
  // cancelled (terminal), so there is no live run and the surface correctly shows the composer +
  // Resume — but the RESUME runs in the main process (a typed reply's or Continue's resume ticket),
  // and the renderer has no invalidation for it. Stopping the poll here means the run going live
  // again is never observed and the composer sticks for the rest of the session. The docstring's
  // "invalidations keep things fresh" holds for a finished run, not for a resumable one.
  const status = data?.task?.status;
  return status === 'needs_attention' || status === 'cancelled' ? 5000 : false;
}
