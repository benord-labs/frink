import type { TaskSignalState } from '../../../../../../shared/types/task-signal';

type TaskWithResult = {
  status?: string;
  result?: unknown;
  triggerContext?: unknown;
} | null;

export type TaskCompletionAction =
  | 'complete'
  | 'mark_plan_ready'
  | 'mark_done'
  | 'needs_attention'
  | 'failed'
  | null;

function readSkipReview(result: unknown): boolean {
  if (typeof result !== 'object' || result == null) return false;
  const value = (result as Record<string, unknown>).skipReview;
  return value === true;
}

function readStartMode(result: unknown): string | null {
  if (typeof result !== 'object' || result == null) return null;
  const value = (result as Record<string, unknown>).startMode;
  return typeof value === 'string' ? value : null;
}

function readTaskSignalState(result: unknown): TaskSignalState | null {
  if (typeof result !== 'object' || result == null) return null;
  const signal = (result as Record<string, unknown>).agentSignal;
  if (typeof signal !== 'object' || signal == null) return null;
  const state = (signal as Record<string, unknown>).state;
  return typeof state === 'string' ? (state as TaskSignalState) : null;
}

function readQuietEndedAt(result: unknown): string | null {
  if (typeof result !== 'object' || result == null) return null;
  const value = (result as Record<string, unknown>).quietEndedAt;
  return typeof value === 'string' ? value : null;
}

function readStartModeFromTriggerContext(triggerContext: unknown): string | null {
  if (typeof triggerContext !== 'object' || triggerContext === null) return null;
  const config = (triggerContext as { _config?: unknown })._config;
  if (typeof config !== 'object' || config === null) return null;
  const value = (config as { startMode?: unknown }).startMode;
  return typeof value === 'string' ? value : null;
}

/** Signal states with a fixed action regardless of start mode. Other states (done, or the synthetic
 * manual_confirmation / missing_completion_signal) fall through to the mode-aware branches below. */
const FIXED_SIGNAL_ACTIONS: Partial<Record<TaskSignalState, TaskCompletionAction>> = {
  failed: 'failed',
  completed: 'complete',
  // biome-ignore lint/style/useNamingConvention: task-signal state used as discriminator
  awaiting_input: 'needs_attention',
  blocked: 'needs_attention',
  partial: 'needs_attention',
};

/** Streaming ended for a running task: pick the transition its recorded result justifies. */
export function resolveAutoCompletionAction(task: TaskWithResult): TaskCompletionAction {
  if (task?.status !== 'running') return null;
  const signalState = readTaskSignalState(task?.result);
  const startMode =
    readStartMode(task?.result) ?? readStartModeFromTriggerContext(task?.triggerContext);
  const planAction: TaskCompletionAction = readSkipReview(task?.result)
    ? 'complete'
    : 'mark_plan_ready';
  if (signalState === 'done') {
    return startMode === 'plan' ? planAction : 'mark_done';
  }
  const fixedAction = signalState ? FIXED_SIGNAL_ACTIONS[signalState] : undefined;
  if (fixedAction) return fixedAction;
  // Quiet turn-end marker (written by the main process): the agent stopped without a signal but
  // may be waiting on background work (e.g. a wake hold on live subagents). Defer to the flows
  // quiet-idle sweep instead of acting the moment streaming ends — for plan tasks too, or a
  // drafting agent still waiting on its research subagents gets marked plan_ready with no plan.
  // A SUBMITTED plan never carries the marker (the main process suppresses it on the halt path),
  // so the plan branch below still fires for a real submission.
  if (readQuietEndedAt(task?.result) != null) return null;
  if (startMode === 'plan') return planAction;
  // No signal, no marker: main's turn-end duties are pending or the streaming flag flipped mid-turn.
  // Never park on silence here — the flows watcher is the parking authority (flow-quiet-wait-handling).
  return null;
}
