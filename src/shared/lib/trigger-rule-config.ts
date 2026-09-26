import { getTriggerConfigRecord, type TriggerContext } from '../types/trigger-context';
import type { TaskResultRecord } from '../types/task-result';
import {
  TRIGGER_COMPLETION_SIGNALS,
  TRIGGER_START_MODES,
  type TriggerCompletionSignal,
  type TriggerStartMode,
} from '../types/trigger-context';

const DEFAULT_COMPLETION_SIGNAL: TriggerCompletionSignal = 'agent_finish';

type RawTriggerConfig = TriggerContext['_config'] | TaskResultRecord;

export function resolveRuleStartMode(
  actionConfig: Record<string, unknown> | undefined,
): TriggerStartMode {
  const startMode = actionConfig?.start_mode;
  if (
    typeof startMode === 'string' &&
    TRIGGER_START_MODES.includes(startMode as TriggerStartMode)
  ) {
    return startMode as TriggerStartMode;
  }
  return TRIGGER_START_MODES[0];
}

export function resolveRuleStartInWorktree(
  actionConfig: Record<string, unknown> | undefined,
): boolean {
  const startInWorktree = actionConfig?.start_in_worktree;
  if (typeof startInWorktree === 'boolean') {
    return startInWorktree;
  }
  return true;
}

export function resolveRuleCompletionSignal(
  actionConfig: Record<string, unknown> | undefined,
): TriggerCompletionSignal {
  const completionSignal = actionConfig?.completion_signal;
  if (
    typeof completionSignal === 'string' &&
    TRIGGER_COMPLETION_SIGNALS.includes(completionSignal as TriggerCompletionSignal)
  ) {
    return completionSignal as TriggerCompletionSignal;
  }
  return DEFAULT_COMPLETION_SIGNAL;
}

export function resolveTaskStartInWorktreePreference(
  configuredStartInWorktree: boolean | undefined,
  projectId: string | null | undefined,
): boolean {
  if (typeof configuredStartInWorktree === 'boolean') {
    return configuredStartInWorktree;
  }
  return Boolean(projectId);
}

export function isRuleAutoStartEnabled(actionConfig: Record<string, unknown> | undefined): boolean {
  return resolveRuleStartMode(actionConfig) === 'execute';
}

export type ResolvedTaskStartMode = Exclude<TriggerStartMode, 'wait'>;
// Mirrors ChatMode ('agent'|'plan'|'debug'). Kept as a local literal (not an import from
// src/shared/types/chat-mode) so the vercel `_shared` sync stays self-contained.
export type ChatStartMode = 'agent' | 'plan' | 'debug';

type ResolveTaskExecutionMetadataOptions = {
  overrideMode?: ChatStartMode;
  throwOnWait?: boolean;
};

function readConfigStartMode(config: RawTriggerConfig | undefined): TriggerStartMode | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const configRecord = config as Record<string, unknown>;
  const rawMode = configRecord.startMode ?? configRecord.start_mode;
  if (typeof rawMode !== 'string') return undefined;
  return TRIGGER_START_MODES.includes(rawMode as TriggerStartMode)
    ? (rawMode as TriggerStartMode)
    : undefined;
}

function readConfiguredModel(config: RawTriggerConfig | undefined): string | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const configRecord = config as Record<string, unknown>;
  // Prefer camelCase for typed config, but keep snake_case fallback for legacy payloads.
  const rawModel =
    typeof configRecord.model === 'string'
      ? configRecord.model
      : typeof configRecord.configured_model === 'string'
        ? configRecord.configured_model
        : undefined;
  if (typeof rawModel !== 'string') return undefined;
  const trimmed = rawModel.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readConfigStartInWorktree(config: RawTriggerConfig | undefined): boolean | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const configRecord = config as Record<string, unknown>;
  const rawValue = configRecord.startInWorktree ?? configRecord.start_in_worktree;
  return typeof rawValue === 'boolean' ? rawValue : undefined;
}

function readConfigSkipReview(config: RawTriggerConfig | undefined): boolean | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const configRecord = config as Record<string, unknown>;
  const rawValue = configRecord.skipReview ?? configRecord.skip_review;
  return typeof rawValue === 'boolean' ? rawValue : undefined;
}

function readConfigCompletionSignal(
  config: RawTriggerConfig | undefined,
): TriggerCompletionSignal | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const configRecord = config as Record<string, unknown>;
  const rawValue = configRecord.completionSignal ?? configRecord.completion_signal;
  if (typeof rawValue !== 'string') return undefined;
  return TRIGGER_COMPLETION_SIGNALS.includes(rawValue as TriggerCompletionSignal)
    ? (rawValue as TriggerCompletionSignal)
    : undefined;
}

export function resolveTaskExecutionMetadata(
  config: RawTriggerConfig | undefined,
  options?: ResolveTaskExecutionMetadataOptions,
): {
  startMode: ResolvedTaskStartMode;
  skipReview: boolean;
  configuredModel?: string;
} {
  const modeFromOverride: ResolvedTaskStartMode =
    options?.overrideMode === 'plan'
      ? 'plan'
      : options?.overrideMode === 'debug'
        ? 'debug'
        : 'execute';
  const requestedStartMode = options?.overrideMode ? modeFromOverride : readConfigStartMode(config);
  if (requestedStartMode === 'wait' && options?.throwOnWait) {
    throw new Error('Wait-mode tasks must remain queued and should not be executed');
  }
  const startMode: ResolvedTaskStartMode =
    requestedStartMode === 'plan' ? 'plan' : requestedStartMode === 'debug' ? 'debug' : 'execute';
  const configuredModel = readConfiguredModel(config);
  // An explicit `_config.skipReview` (set by a flow agent node's autoApprove) wins over the derived
  // default. Default: only plan mode pauses for review; execute/debug auto-complete.
  const explicitSkipReview = readConfigSkipReview(config);
  return {
    startMode,
    skipReview: explicitSkipReview ?? startMode !== 'plan',
    ...(configuredModel ? { configuredModel } : {}),
  };
}

export function resolveTaskCompletionSignal(
  config: RawTriggerConfig | undefined,
): TriggerCompletionSignal {
  return readConfigCompletionSignal(config) ?? DEFAULT_COMPLETION_SIGNAL;
}

export function toChatMode(startMode: ResolvedTaskStartMode): ChatStartMode {
  return startMode === 'plan' ? 'plan' : startMode === 'debug' ? 'debug' : 'agent';
}

export function resolveTaskStartInWorktreeFromConfig(
  config: RawTriggerConfig | undefined,
  projectId: string | null | undefined,
): boolean {
  return resolveTaskStartInWorktreePreference(readConfigStartInWorktree(config), projectId);
}

/**
 * Extracts `_config` from any trigger_context shape without requiring the full TriggerContext.
 * Used for flow-originated tasks (manual, schedule, post_task triggers) where trigger_context
 * is a minimal object like `{ _frinkTrigger: 'schedule_trigger', _config: { ... } }`.
 */
export function extractRawTriggerConfig(
  triggerContext: TaskResultRecord | null | undefined,
): TaskResultRecord | undefined {
  return getTriggerConfigRecord(triggerContext);
}
