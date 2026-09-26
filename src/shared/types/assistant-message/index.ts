import type { InvoluntaryAbortReason } from '../../lib/user-abort-error';

/**
 * A tool call's lifecycle, in the AI SDK's vocabulary — the contract both `applyChunkToParts`
 * (main process) and the SDK's own reducer must agree on. Spelled out rather than imported from
 * `ai`: this module also ships in the serverless bundle, which has no dependency on the SDK.
 * `tool-part-state.test.ts` checks the subset relationship at compile time instead.
 */
export type ToolPartState =
  | 'input-streaming'
  | 'input-available'
  | 'output-available'
  | 'output-error';

/** States meaning a tool call is over, successfully or not. */
export const TERMINAL_TOOL_PART_STATES: ReadonlySet<string> = new Set([
  'output-available',
  'output-error',
]);

/**
 * Trailer stamped on an assistant message when its turn ends — usage/cost for the footer, plus how
 * the turn ended when that is not self-evident from the parts.
 *
 * Shared because it crosses the process wall on every turn: the executor writes it through
 * ExecuteCompletePayload, `finalizeAssistantMessage` persists it, and the renderer reads the same
 * shape back. It had drifted into a main copy and a renderer copy that were already out of step.
 */
export type AssistantMessageMetadata = {
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  resultSubtype?: string;
  finalTextId?: string;
  /** Tokens in the context window after this turn, and the window's size (composer ring). */
  contextTokens?: number;
  contextWindow?: number;
  /** When the turn's prompt cache goes cold at the latest (epoch ms; composer cache timer). */
  promptCacheExpiresAt?: number;
  /** Set when Frink — not the user — tore this turn down. The persisted record of the teardown. */
  interruptedBy?: InvoluntaryAbortReason;
};

/**
 * Whether a terminal stream edge finalized into the persisted transcript.
 *
 * A committed edge means the local SQLite write completed — the renderer can safely invalidate
 * and refetch its transcript query. A non-durable edge (finalize failed, or no sub-chat row) means
 * the stream ended without a persisted write to fall back on.
 */
export type TranscriptTerminalDurability =
  | { durability: 'committed' }
  | { durability: 'non-durable' };
