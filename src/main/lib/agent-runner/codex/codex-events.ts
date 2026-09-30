/**
 * Pure mapping functions between the codex app-server wire protocol and Frink's
 * {@link UIMessageChunk} stream + permission gate.
 *
 * Kept as TOP-LEVEL pure functions (no process, no I/O) so they unit-test
 * without spawning anything (rule #11). The runner ({@link runCodexAgent})
 * owns the stateful streaming; this module owns the per-event translation.
 *
 * Wire contract verified against the codex clone (app-server-protocol v2):
 *  - all payloads are serde `rename_all = "camelCase"` → `threadId`, `turnId`,
 *    `itemId`, `startedAtMs`, `commandActions`, etc.
 *  - approval decisions are camelCase strings: `accept` / `acceptForSession` /
 *    `decline` / `cancel` (item.rs CommandExecution/FileChangeApprovalDecision).
 */

import { z } from 'zod';
import { CODEX_SUBAGENT_TOOL_NAME } from '../../../../shared/subagent-parts';
import { usageLimitErrorChunk } from '../../claude/stream-classifiers';
import type { UIMessageChunk } from '../../claude/types';

/** Result of Frink's permission gate, as returned by `validateToolPermission`. */
export type ApprovalOutcome =
  | { allowed: true }
  | { allowed: false; message: string }
  | { allowed: null };

/** Server→client approval-request methods we bind to Frink's gate. */
export const COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval';
export const FILE_CHANGE_APPROVAL_METHOD = 'item/fileChange/requestApproval';
/**
 * Sandbox/network escalation approval. Frink has no gate for it (no UI), but the
 * server still expects a response — so the client declines it by default rather
 * than leaving the request unanswered (an unanswered server→client request hangs
 * the turn).
 */
export const PERMISSIONS_APPROVAL_METHOD = 'item/permissions/requestApproval';
export const APPROVAL_REQUEST_METHODS = [
  COMMAND_APPROVAL_METHOD,
  FILE_CHANGE_APPROVAL_METHOD,
  PERMISSIONS_APPROVAL_METHOD,
] as const;

export function declineApprovalResponse(): Record<string, unknown> {
  return { decision: 'decline' };
}

/**
 * Normalized approval request — what Frink's `validateToolPermission` consumes.
 * `toolName`/`input` mirror the Claude tool shape so the same gate runs.
 */
export type CodexApprovalRequest = {
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  mcp?: { server: string; tool: string };
};

type CommandApprovalParams = {
  command?: string;
  cwd?: string;
  reason?: string;
  commandActions?: unknown;
};

type FileChangeApprovalParams = {
  reason?: string;
  grantRoot?: string;
};

/** A single edited file inside a codex `fileChange` item (item.changes[]). */
export type FileChange = { path?: string };

/**
 * Map a server→client approval request into the shape(s) Frink's permission gate
 * expects. A command-exec request becomes a single `Bash` tool call (routed through
 * the same bash policy as Claude). A file-change request becomes one `Edit`
 * per real per-file path (resolved from the cached `fileChange` item the runner
 * passes in), falling back to the grant root, then an empty path that makes the gate
 * prompt. Returns a NON-EMPTY list always — an empty list would vacuously accept.
 *
 * codex answers a fileChange request with ONE decision for the whole patch (no
 * per-file slot — `FileChangeRequestApprovalResponse` carries a single `decision`),
 * so the runner gates the returned list all-or-nothing (one denial declines the patch).
 */
export function mapApprovalRequests(
  method: string,
  params: unknown,
  changes?: FileChange[],
): CodexApprovalRequest[] {
  const p = (params ?? {}) as CommandApprovalParams & FileChangeApprovalParams;

  if (method === COMMAND_APPROVAL_METHOD) {
    return [
      { toolName: 'Bash', input: { command: p.command ?? '', cwd: p.cwd }, reason: p.reason },
    ];
  }

  // FILE_CHANGE_APPROVAL_METHOD: prefer the real per-file paths from the cached
  // fileChange item; else the grant root; else an empty path (gate prompts — the
  // retained safe default for a cache-miss or a path-less patch).
  const paths = (changes ?? []).map((c) => c.path).filter((path): path is string => !!path);
  const targets = paths.length > 0 ? paths : [p.grantRoot ?? ''];
  return targets.map((path) => ({
    toolName: 'Edit',
    input: { file_path: path },
    reason: p.reason,
  }));
}

/**
 * Pull the (itemId, changes) off an `item/started` notification for a `fileChange`
 * item, so the runner can cache it and resolve real per-file paths when the matching
 * approval request fires. Returns null for any non-fileChange item.
 */
export function extractFileChangeItem(
  params: unknown,
): { itemId: string; changes: FileChange[] } | null {
  const item = (params as { item?: Record<string, unknown> }).item;
  if (item?.type !== 'fileChange') return null;
  const itemId = String(item.id ?? '');
  // An id-less item can't be correlated to its approval; caching under '' would
  // collide with the cache-miss lookup (an absent approval itemId also resolves to '').
  if (!itemId) return null;
  const changes = Array.isArray(item.changes) ? (item.changes as FileChange[]) : [];
  return { itemId, changes };
}

/** Human phrase per collab operation; becomes the subagent card's subtitle. */
const COLLAB_TOOL_LABELS: Record<string, string> = {
  spawnAgent: 'Spawning agent',
  sendInput: 'Sending input to agent',
  resumeAgent: 'Resuming agent',
  wait: 'Waiting on agents',
  closeAgent: 'Closing agent',
};

/** A field read as a string, or a default when the wire omitted it or sent another type. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

type ItemAdapter = {
  /** Card name. Omit to fall back to the synthetic `codex_<type>`. */
  name?: (item: Record<string, unknown>) => string;
  input?: (item: Record<string, unknown>) => Record<string, unknown>;
  /** Completion payload. Omit to reuse `input` — right for items whose result IS their subject. */
  output?: (item: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Failure message when this item completed unsuccessfully, else undefined.
   *
   * Kept separate from `output` because a failure must travel as `tool-output-error`: that is the
   * one channel card readers actually check (it sets `errorText` / `output-error`). Signalling
   * failure inside the output payload instead leaves a failed job rendering as a completed one.
   */
  error?: (item: Record<string, unknown>) => string | undefined;
};

/**
 * Per-ThreadItem card shape, as a table rather than three parallel switches.
 *
 * Same reason {@link NOTIFICATION_HANDLERS} is a lookup: a variant's name, input and output belong
 * together, and adding the next one should be a single entry rather than an edit in three places
 * that can silently disagree. Absent from this table is not an error — see {@link isToolItem}; an
 * unmapped variant still renders, under its synthetic name with an empty payload.
 */
const ITEM_ADAPTERS: Record<string, ItemAdapter> = {
  commandExecution: {
    name: () => 'Bash',
    input: (i) => ({ command: i.command, cwd: i.cwd }),
    output: (i) => ({ output: i.aggregatedOutput ?? '', exitCode: i.exitCode ?? null }),
    error: (i) =>
      i.status === 'declined'
        ? str(i.aggregatedOutput, 'Command denied by permissions')
        : undefined,
  },
  fileChange: { name: () => 'Edit', input: (i) => ({ changes: i.changes }) },
  webSearch: { name: () => 'WebSearch', input: (i) => ({ query: i.query }) },
  mcpToolCall: {
    name: (i) => `mcp__${str(i.server, 'mcp')}__${str(i.tool, 'tool')}`,
    input: (i) => (i.arguments as Record<string, unknown>) ?? {},
    output: (i) => (i.error ? { error: i.error } : ((i.result as Record<string, unknown>) ?? {})),
  },
  dynamicToolCall: {
    name: (i) => str(i.tool, 'tool'),
    input: (i) => (i.arguments as Record<string, unknown>) ?? {},
  },
  imageGeneration: {
    name: () => 'ImageGeneration',
    input: (i) => ({ prompt: i.revisedPrompt ?? '' }),
    // Only the saved path travels: the bitmap already lives on disk (`result` is the same PNG as
    // bare base64, multi-MB per image) and the card reads the file back via files.readImageFile.
    output: (i) => ({ path: i.savedPath ?? null }),
    // `status` is a bare String upstream, so anything that is not an explicit success is a failure
    // rather than one matched literal.
    error: (i) =>
      i.status === 'completed'
        ? undefined
        : imageGenerationFailureText(imageGenerationFailureSchema.parse(i.failure)),
  },
  collabAgentToolCall: {
    // Routes through the same subagent card Claude's Task tool uses (live elapsed timer).
    name: () => CODEX_SUBAGENT_TOOL_NAME,
    // `description` is what the subagent card reads for its subtitle (getSubagentLabel).
    input: (i) => ({ description: collabDescription(i), prompt: i.prompt, model: i.model }),
    output: (i) => ({ agents: i.agentsStates ?? {} }),
    // Only an explicit `completed` reads as success. CollabAgentToolCallStatus is closed at
    // inProgress|completed|failed today, so this is equivalent to `=== 'failed'` — but the item is
    // terminal by the time it reaches here, and defaulting an unrecognised terminal status to
    // success is how a job silently claims to have worked. Same rule as imageGeneration above.
    error: (i) => (i.status === 'completed' ? undefined : `${collabDescription(i)} failed`),
  },
  // A per-child lifecycle marker, distinct from the parent's collab job card above: naming it by
  // kind keeps the pair reading as one story ("Running Subagent" + "Subagent started").
  subAgentActivity: {
    name: (i) => {
      const kind = str(i.kind, 'activity');
      return `Subagent${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    },
    input: (i) => ({ path: i.agentPath }),
  },
  sleep: { name: () => 'Sleep', input: (i) => ({ durationMs: i.durationMs }) },
};

/** Codex `ImageGenerationFailure` on the wire; anything unrecognised reads as no detail. */
const imageGenerationFailureSchema = z
  .object({ type: z.string(), resetsAt: z.number().nullish() })
  .nullish()
  .catch(null);

/**
 * Plain-language failure for an image item. Upstream sends `result: ""` on every failure and fills
 * `failure` only for the image_gen usage limit, so the reason has to be built here, not read.
 */
function imageGenerationFailureText(failure: z.infer<typeof imageGenerationFailureSchema>): string {
  if (failure?.type !== 'usageLimitExceeded') return 'Image generation failed';
  return failure.resetsAt == null
    ? 'Image generation limit reached'
    : `Image generation limit reached, resets ${new Date(failure.resetsAt * 1000).toLocaleString()}`;
}

/** Stable per-item synthetic tool name for the UI tool card. */
function toolNameForItem(item: Record<string, unknown>): string {
  const type = str(item.type, '');
  return ITEM_ADAPTERS[type]?.name?.(item) ?? (type ? `codex_${type}` : 'codex_tool');
}

/**
 * ThreadItem variants that are NOT jobs and must never render a tool card. Everything else IS one.
 *
 * Deliberately a denylist, not an allowlist. The codex ThreadItem union grows over time (19 variants
 * at the pinned rust-v0.155.1) and a closed allowlist fails SILENTLY — a new kind of long-running
 * work simply vanishes from the transcript, which is exactly how image generation and subagents came
 * to look like an idle conversation. A denylist fails VISIBLY: an unmapped variant still surfaces
 * under a synthetic `codex_<type>` name that a reader can act on.
 */
const NON_TOOL_ITEM_TYPES = new Set([
  'agentMessage', // streamed as text via item/agentMessage/delta
  'reasoning', // streamed as reasoning via item/reasoning/*
  'plan', // streamed as reasoning via item/plan/delta
  'userMessage', // the prompt Frink itself sent
  'hookPrompt', // injected hook text, not work the user is waiting on
  'enteredReviewMode', // lifecycle marker: starts and completes back-to-back
  'exitedReviewMode', // lifecycle marker: starts and completes back-to-back
  'imageView', // instantaneous attachment read, not a job
  'contextCompaction', // internal housekeeping
  'functionCallOutput', // client-submitted standalone tool output (hook runtime); never a job, never shown upstream
]);

/** True for ThreadItem variants Frink surfaces as a tool card (not text/reasoning/lifecycle). */
function isToolItem(type: unknown): boolean {
  return typeof type === 'string' && !NON_TOOL_ITEM_TYPES.has(type);
}

/** The open-card half of a tool item (input-start + input-available). */
function openToolCard(item: Record<string, unknown>, startedAt?: number): UIMessageChunk[] {
  const toolCallId = String(item.id ?? '');
  const toolName = toolNameForItem(item);
  return [
    { type: 'tool-input-start', toolCallId, toolName },
    {
      type: 'tool-input-available',
      toolCallId,
      toolName,
      input: toolInputForItem(item, startedAt),
    },
  ];
}

/** item.started → open a tool card. `startedAtMs` rides the notification, so this stays pure. */
function mapItemStarted(item: Record<string, unknown>, startedAtMs?: number): UIMessageChunk[] {
  if (!isToolItem(item.type)) return [];
  return openToolCard(item, startedAtMs);
}

/** Best-effort input payload for the tool card from a ThreadItem. */
function baseToolInput(item: Record<string, unknown>): Record<string, unknown> {
  return ITEM_ADAPTERS[str(item.type, '')]?.input?.(item) ?? {};
}

/** Subtitle for a collab job card: the operation, plus the agent count when it acts on several. */
function collabDescription(item: Record<string, unknown>): string {
  const label = COLLAB_TOOL_LABELS[str(item.tool, '')] ?? str(item.tool, 'Collab agent');
  const count = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
  return count > 1 ? `${label} (${count})` : label;
}

/**
 * Input payload plus the card's start timestamp when known. `startedAt` is the key the subagent
 * card's elapsed timer reads, matching how Claude's Task cards are timed.
 *
 * Only a plausible instant is stamped. The card renders `Date.now() - startedAt`, so a zero, a
 * negative, or a NaN is not merely useless but actively wrong: zero reads as the epoch and silently
 * disables the timer, while a negative survives the card's own truthiness guard and renders an age
 * of several million minutes. Absent is honest; the card then shows no elapsed time at all.
 */
function toolInputForItem(
  item: Record<string, unknown>,
  startedAt?: number,
): Record<string, unknown> {
  const base = baseToolInput(item);
  const isPlausibleInstant = startedAt !== undefined && Number.isFinite(startedAt) && startedAt > 0;
  return isPlausibleInstant ? { ...base, startedAt } : base;
}

/** The output payload for a completed tool item; falls back to the input for result-is-subject items. */
function toolOutputForItem(item: Record<string, unknown>): Record<string, unknown> {
  const adapter = ITEM_ADAPTERS[str(item.type, '')];
  return adapter?.output?.(item) ?? adapter?.input?.(item) ?? {};
}

/**
 * Start timestamp to stamp on a completion. A completed-only item never sent one, so derive it from
 * the wire duration when present, else fall back to the completion instant (a neutral zero elapsed).
 * Returns undefined when the notification carried no timestamp at all — stamping 0 there would date
 * the card to 1970 and render a ~56-year elapsed time.
 */
function startedAtForCompletion(
  item: Record<string, unknown>,
  completedAtMs?: number,
): number | undefined {
  if (completedAtMs === undefined) return undefined;
  return completedAtMs - (typeof item.durationMs === 'number' ? item.durationMs : 0);
}

/** item.completed → close the tool card or text block (output / text-end). */
function mapItemCompleted(item: Record<string, unknown>, completedAtMs?: number): UIMessageChunk[] {
  const id = String(item.id ?? '');
  // The agentMessage text streamed via delta; just close the text block.
  if (item.type === 'agentMessage') return [{ type: 'text-end', id }];
  if (!isToolItem(item.type)) return [];
  // Re-open the card before closing it. Some variants are emitted ONLY as item/completed upstream
  // (subAgentActivity goes exclusively through emit_turn_item_completed), and the parts reducer
  // DROPS an output whose toolCallId it never opened — so output-alone would render nothing at all.
  // Re-sending the input for a normally-started item is safe: that branch is an idempotent upsert
  // which refuses to downgrade a terminal state, so it updates the open card instead of duplicating.
  const errorText = ITEM_ADAPTERS[str(item.type, '')]?.error?.(item);
  return [
    ...openToolCard(item, startedAtForCompletion(item, completedAtMs)),
    errorText === undefined
      ? { type: 'tool-output-available', toolCallId: id, output: toolOutputForItem(item) }
      : { type: 'tool-output-error', toolCallId: id, errorText },
  ];
}

/**
 * thread/tokenUsage/updated → message-metadata. `total` is the running spend; `last` is the latest
 * call, whose total is what currently sits in the context window (codex's own context meter).
 */
function mapTokenUsage(params: Record<string, unknown>): UIMessageChunk[] {
  type Breakdown = { totalTokens?: number; inputTokens?: number; outputTokens?: number };
  const usage = params.tokenUsage as
    | { total?: Breakdown; last?: Breakdown; modelContextWindow?: number | null }
    | undefined;
  const total = usage?.total;
  if (!total) return [];
  return [
    {
      type: 'message-metadata',
      messageMetadata: {
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        totalTokens: total.totalTokens,
        contextTokens: usage.last?.totalTokens,
        contextWindow: usage.modelContextWindow ?? undefined,
      },
    },
  ];
}

/**
 * Map a single codex server notification to zero or more {@link UIMessageChunk}.
 *
 * Streaming text deltas need a one-time `text-start` per itemId; the runner owns
 * that gating (it tracks open text ids) and calls this for the delta payload, so
 * this function emits the bare `text-delta`/`reasoning-delta` and lets the runner
 * bracket it. Lifecycle (`item/started`, `item/completed`, `turn/completed`,
 * `thread/tokenUsage/updated`, `error`) is fully self-contained here.
 */
/** A streaming text/reasoning delta keyed by itemId. */
function mapDelta(
  type: 'text-delta' | 'reasoning-delta',
  p: Record<string, unknown>,
): UIMessageChunk[] {
  return [{ type, id: String(p.itemId ?? ''), delta: String(p.delta ?? '') }];
}

/** True for the two coalescable streamed-delta chunk kinds (carry id + delta). */
function isStreamDelta(
  chunk: UIMessageChunk,
): chunk is Extract<UIMessageChunk, { type: 'text-delta' | 'reasoning-delta' }> {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta';
}

/**
 * Coalesce two adjacent streamed deltas of the SAME kind + itemId into one chunk.
 * Returns the merged chunk, or null when they must NOT merge (different itemId,
 * different kind, or either is not a text/reasoning delta). The runner's queue uses
 * this to bound IPC chatter + memory under backpressure without dropping a byte;
 * reconstructed text is byte-identical to the un-coalesced stream.
 */
export function mergeDelta(prev: UIMessageChunk, next: UIMessageChunk): UIMessageChunk | null {
  if (
    isStreamDelta(prev) &&
    isStreamDelta(next) &&
    prev.type === next.type &&
    prev.id === next.id
  ) {
    return { ...next, delta: prev.delta + next.delta };
  }
  return null;
}

/**
 * turn/completed: a failed/interrupted turn is reported HERE via turn.status
 * (+ turn.error), not a separate notification — codex has no `turn/failed`.
 * TurnStatus wire values are camelCase (v2/turn.rs): completed/interrupted/failed/inProgress.
 */
function mapTurnCompleted(p: Record<string, unknown>): UIMessageChunk[] {
  const turn = p.turn as { status?: string; error?: CodexTurnError } | undefined;
  if (turn?.status === 'failed' || turn?.status === 'interrupted') {
    return [codexErrorChunk(turn.error, `Codex turn ${turn.status}`)];
  }
  return [{ type: 'finish' }];
}

/** error: ErrorNotification (v2/notification.rs) is { error: TurnError, willRetry, ... }; string at error.message. */
function mapError(p: Record<string, unknown>): UIMessageChunk[] {
  return [codexErrorChunk(p.error as CodexTurnError, 'Codex error')];
}

type CodexTurnError = { message?: string; codexErrorInfo?: unknown } | undefined;

/** Codex flags a usage limit structurally (TurnError.codexErrorInfo), so no wording is matched. */
function codexErrorChunk(error: CodexTurnError, fallback: string): UIMessageChunk {
  const errorText = String(error?.message ?? fallback);
  if (error?.codexErrorInfo === 'usageLimitExceeded') return usageLimitErrorChunk(errorText);
  return { type: 'error', errorText };
}

/**
 * Per-method handlers. Data-driven dispatch keeps mapNotificationToChunks a flat
 * lookup (no growing switch). Streamed command output is intentionally a noop —
 * it's surfaced in the final tool-output-available on item/completed.
 */
const NOTIFICATION_HANDLERS: Record<string, (p: Record<string, unknown>) => UIMessageChunk[]> = {
  'item/agentMessage/delta': (p) => mapDelta('text-delta', p),
  'item/reasoning/textDelta': (p) => mapDelta('reasoning-delta', p),
  'item/reasoning/summaryTextDelta': (p) => mapDelta('reasoning-delta', p),
  // A new summary section starts here; inject a blank-line break so multi-section
  // hosted-model reasoning doesn't render as one run-on paragraph. The single
  // accumulator ignores summaryIndex, so the break must ride the stream itself.
  'item/reasoning/summaryPartAdded': (p) => [
    { type: 'reasoning-delta', id: String(p.itemId ?? ''), delta: '\n\n' },
  ],
  'item/plan/delta': (p) => mapDelta('reasoning-delta', p),
  'item/commandExecution/outputDelta': () => [],
  'item/started': (p) =>
    mapItemStarted(
      (p.item as Record<string, unknown>) ?? {},
      typeof p.startedAtMs === 'number' ? p.startedAtMs : undefined,
    ),
  'item/completed': (p) =>
    mapItemCompleted(
      (p.item as Record<string, unknown>) ?? {},
      typeof p.completedAtMs === 'number' ? p.completedAtMs : undefined,
    ),
  'thread/tokenUsage/updated': mapTokenUsage,
  'turn/completed': mapTurnCompleted,
  error: mapError,
};

export function mapNotificationToChunks(method: string, params: unknown): UIMessageChunk[] {
  return NOTIFICATION_HANDLERS[method]?.((params ?? {}) as Record<string, unknown>) ?? [];
}
