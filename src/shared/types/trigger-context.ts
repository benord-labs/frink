/**
 * Trigger Context - Rich metadata for AI context awareness
 *
 * Stores information about the external trigger that created a task,
 * enabling Claude to understand where the task came from and what's expected.
 *
 * @see Research: R-131756 (Devin AI trigger contextualization)
 * @see Phase 4.11: todos/phase-4-triggers/11-trigger-context-schema.md
 */

/**
 * Supported integration providers. Every id in `PROVIDERS` must appear here — the provider
 * catalog's own test proves it, so a new row cannot ship a source this union rejects.
 */
export const TRIGGER_SOURCES = [
  'slack',
  'notion',
  'gmail',
  'shortcut',
  'clickup',
  'linear',
  'github',
  'posthog',
  'atlassian',
  'huggingface',
  'webflow',
  'sentry',
  'cloudflare',
  'vercel',
  'supabase',
  'square',
  'paypal',
  'generic_webhook',
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];
// 'debug' = run the agent in hypothesis-driven debug mode (Frink ChatMode parity). Appended last so
// TRIGGER_START_MODES[0] stays 'execute' (the auto-start default). Debug is local-execution-only —
// flow/cloud dispatch hard-errors it on non-local targets (no NDJSON ingest server off-machine).
export const TRIGGER_START_MODES = ['execute', 'plan', 'wait', 'debug'] as const;
export type TriggerStartMode = (typeof TRIGGER_START_MODES)[number];
export const TRIGGER_COMPLETION_SIGNALS = ['agent_finish', 'manual'] as const;
export type TriggerCompletionSignal = (typeof TRIGGER_COMPLETION_SIGNALS)[number];

/**
 * Information about who/what triggered the event
 */
type TriggerActor = {
  /** User ID in the external system */
  externalUserId?: string;
  /** Display name */
  name?: string;
  /** Email if available */
  email?: string;
};

/**
 * Links to related resources in the source system
 */
type TriggerRelatedContext = {
  /** Link to Slack thread, email thread, etc. */
  threadUrl?: string;
  /** Link to ticket/issue in external system */
  issueUrl?: string;
  /** Link to repository (GitHub) */
  repositoryUrl?: string;
  /** Link to pull request */
  pullRequestUrl?: string;
};

/**
 * Rich metadata about the trigger that created a task.
 * Enables AI to understand where the task came from and what's expected.
 *
 * This is stored in `tasks.trigger_context` JSONB column.
 */
export type TriggerContext = {
  /** Which integration triggered this task */
  source: TriggerSource;

  /** Which connected account (for multi-account support) */
  sourceAccountId: string;
  /**
   * Human-readable account name: "john@gmail.com", "acme-workspace".
   * Optional: legacy rule-based triggers set it; flow-as-trigger has no account name
   * (only `sourceAccountId` = integrationId).
   */
  sourceAccountName?: string;

  /**
   * Legacy rule-based trigger identity. Optional: flow-as-trigger has "no separate trigger
   * rule" (the flow IS the trigger), so the flow-webhook producer never sets these. Kept
   * optional so old rule-shaped contexts still validate.
   */
  triggerRuleId?: string;
  /** Human-readable rule name: "When email is starred" (legacy rule-based triggers only). */
  triggerRuleName?: string;

  /** Event type that triggered the rule: "email_received", "message_mention" */
  eventType: string;

  /** Who/what triggered it */
  triggeredBy: TriggerActor;

  /** When the trigger occurred (ISO 8601) */
  timestamp: string;

  /** Links to related resources */
  relatedContext?: TriggerRelatedContext;

  /**
   * Full enriched content from the webhook + any additional context fetched.
   * Structure varies by source - see source-specific types below.
   */
  fullContent: Record<string, unknown>;

  /**
   * Whether the task should auto-start immediately.
   * When omitted in stored payloads, treat as `false` — use {@link withTriggerContextDefaults}
   * after validation so runtime code always sees a boolean.
   */
  autoStart?: boolean;

  /**
   * Optional user-authored directive from trigger rule configuration.
   * When present, prompt builders should use this instead of source defaults.
   */
  agentInstructions?: string;

  /**
   * Optional non-event configuration copied from rule settings at task creation time.
   * Kept under `_config` to avoid polluting top-level trigger metadata fields.
   */
  _config?: {
    model?: string;
    startMode?: TriggerStartMode;
    startInWorktree?: boolean;
    completionSignal?: TriggerCompletionSignal;
    /** Flow agent: set when instructions/briefing contain `{{trigger.*}}`; drives TriggerBubble in task executor. */
    showTriggerCard?: boolean;
    /**
     * Flow agent autoApprove: when true, a plan-mode task resolves `done` (not `plan_ready`) so the
     * flow advances without a human gate. Overrides the derived `skipReview = startMode !== 'plan'`
     * default in {@link resolveTaskExecutionMetadata}. Only meaningful for plan mode.
     */
    skipReview?: boolean;
  };
};

// ============================================================================
// Source-Specific Full Content Types
// ============================================================================

/** Gmail trigger full content */
export type GmailFullContent = {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  bodyPlain: string;
  labels: string[];
  threadMessageCount: number;
  hasAttachments: boolean;
  receivedAt: string;
  snippet?: string;
};

// ============================================================================
// Type Guards
// ============================================================================

const TRIGGER_SOURCE_SET = new Set<string>(TRIGGER_SOURCES);

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isTaskResultRecord(
  value: TaskResultRecord[string] | undefined,
): value is TaskResultRecord {
  return isPlainObjectRecord(value);
}

export function getTriggerConfigRecord(
  context: TaskResultRecord | null | undefined,
): TaskResultRecord | undefined {
  return context && isTaskResultRecord(context._config) ? context._config : undefined;
}

/**
 * Runtime check for webhook-shaped trigger_context (full TriggerContext).
 * Minimal flow-only blobs (e.g. only `_config`) intentionally fail; callers should use
 * `extractRawTriggerConfig` when `isValidTriggerContext` is false.
 */
export function isValidTriggerContext(value: unknown): value is TriggerContext {
  if (!isPlainObjectRecord(value)) return false;

  const config = value._config;
  if (config !== undefined) {
    if (!isPlainObjectRecord(config)) return false;
    if (config.model !== undefined && typeof config.model !== 'string') return false;
    if (
      config.startMode !== undefined &&
      (typeof config.startMode !== 'string' ||
        !TRIGGER_START_MODES.includes(config.startMode as TriggerStartMode))
    ) {
      return false;
    }
    if (config.startInWorktree !== undefined && typeof config.startInWorktree !== 'boolean') {
      return false;
    }
    if (
      config.completionSignal !== undefined &&
      !TRIGGER_COMPLETION_SIGNALS.includes(config.completionSignal as TriggerCompletionSignal)
    ) {
      return false;
    }
    if (config.showTriggerCard !== undefined && typeof config.showTriggerCard !== 'boolean') {
      return false;
    }
    if (config.skipReview !== undefined && typeof config.skipReview !== 'boolean') {
      return false;
    }
  }

  // `sourceAccountName`, `triggerRuleId`, `triggerRuleName` are legacy rule-based fields the
  // flow-webhook producer never sets (the flow IS the trigger — no rule). Optional: absent is
  // valid; only a present-but-wrong-typed value fails.
  const optionalStringOk = (v: unknown): boolean => v === undefined || typeof v === 'string';

  return (
    typeof value.source === 'string' &&
    TRIGGER_SOURCE_SET.has(value.source) &&
    typeof value.sourceAccountId === 'string' &&
    optionalStringOk(value.sourceAccountName) &&
    optionalStringOk(value.triggerRuleId) &&
    optionalStringOk(value.triggerRuleName) &&
    typeof value.eventType === 'string' &&
    isPlainObjectRecord(value.triggeredBy) &&
    typeof value.timestamp === 'string' &&
    isPlainObjectRecord(value.fullContent) &&
    (value.autoStart === undefined || typeof value.autoStart === 'boolean')
  );
}

/**
 * Ensures optional trigger fields have stable runtime values (e.g. `autoStart` defaults to false).
 */
export function withTriggerContextDefaults(context: TriggerContext): TriggerContext {
  return { ...context, autoStart: context.autoStart ?? false };
}

/**
 * Check if trigger context is from a specific source
 */
export function isTriggerSource<T extends TriggerSource>(
  ctx: TriggerContext,
  source: T,
): ctx is TriggerContext & { source: T } {
  return ctx.source === source;
}

export function isGmailFullContent(value: unknown): value is GmailFullContent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const labels = candidate.labels;
  return (
    typeof candidate.messageId === 'string' &&
    typeof candidate.threadId === 'string' &&
    typeof candidate.from === 'string' &&
    typeof candidate.to === 'string' &&
    typeof candidate.subject === 'string' &&
    typeof candidate.body === 'string' &&
    typeof candidate.bodyPlain === 'string' &&
    Array.isArray(labels) &&
    labels.every((label) => typeof label === 'string') &&
    typeof candidate.threadMessageCount === 'number' &&
    typeof candidate.hasAttachments === 'boolean' &&
    typeof candidate.receivedAt === 'string'
  );
}
import type { TaskResultRecord } from './task-result';
