/** Plan-turn chunk helpers (moved from executor.ts): the no-card prose replay, the native
 * PlanWrite path extractor, and the persisted-parts builder matching the streamed plan dedupe. */

import crypto from 'node:crypto';
import {
  extractCanonicalPlanTextForFilter,
  filterCanonicalPlanParts,
} from '../../../../shared/plan-parts-filter';
import type { UIMessageChunk } from '../../claude/types';
import { buildPartsFromChunks } from '../claude-turn-context';
import type { MessagePart } from '../client';
import { shouldSuppressPlanTextChunk } from './plan-mode-suppression';

/**
 * The AI SDK stream reducer rejects a lone `text-delta`, and `text-end` is the checkpoint that
 * carries the `parts` payload to the observer lane — so a notice needs its own start/end wrapper.
 */
function buildNoticeChunks(text: string): UIMessageChunk[] {
  const id = crypto.randomUUID();
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ];
}

export type PlanFallbackSend = {
  chunk: UIMessageChunk;
  /** Notice chunks are new and must be appended to the history; replayed prose is already in it. */
  isNotice: boolean;
  messageIndex: number;
};

/** No-card plan turn: replay the prose plan mode hid live, then an optional notice. Indices rise
 * strictly across both — the renderer drops any payload at or below its per-message high-water mark. */
export function buildPlanFallbackSends(
  collectedChunks: UIMessageChunk[],
  startIndex: number,
  noticeText: string | null,
): PlanFallbackSend[] {
  const replayed = collectedChunks.filter((c) => shouldSuppressPlanTextChunk(c, true));
  const notice = noticeText ? buildNoticeChunks(noticeText) : [];
  return [...replayed, ...notice].map((chunk, i) => ({
    chunk,
    isNotice: i >= replayed.length,
    messageIndex: startIndex + i,
  }));
}

/** Send {@link buildPlanFallbackSends}, appending only notice chunks to `collectedChunks` (the prose is
 * already there); returns the next free message index for callers tracking their own counter. */
export function emitPlanFallbackSends(
  collectedChunks: UIMessageChunk[],
  startIndex: number,
  noticeText: string | null,
  send: (item: PlanFallbackSend, parts: MessagePart[]) => void,
): { nextIndex: number; replayedCount: number } {
  const sends = buildPlanFallbackSends(collectedChunks, startIndex, noticeText);
  let parts = buildPartsFromChunks(collectedChunks);
  let replayedCount = 0;
  for (const item of sends) {
    if (item.isNotice) {
      collectedChunks.push(item.chunk);
      parts = buildPartsFromChunks(collectedChunks);
    } else {
      replayedCount++;
    }
    send(item, parts);
  }
  return { nextIndex: startIndex + sends.length, replayedCount };
}

type ToolInputChunk = Extract<UIMessageChunk, { type: 'tool-input-available' }>;

const PATH_KEYS = ['filePath', 'planPath', 'file_path'] as const;
const NESTED_PATH_KEYS = ['filePath', 'planPath', 'plan_path'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function firstNonEmptyPath(record: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** A PlanWrite payload's path: top-level keys first, then the nested `plan` object's. */
function extractPath(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const nested = asRecord(record.plan);
  return (
    firstNonEmptyPath(record, PATH_KEYS) ?? (nested && firstNonEmptyPath(nested, NESTED_PATH_KEYS))
  );
}

const isPlanWriteInput = (chunk: UIMessageChunk): chunk is ToolInputChunk =>
  chunk.type === 'tool-input-available' && 'toolName' in chunk && chunk.toolName === 'PlanWrite';

/** The LAST PlanWrite input path wins; only without one does the FIRST PlanWrite output path count. */
export function extractNativePlanPathFromChunks(chunks: UIMessageChunk[]): string | null {
  const planWrites = chunks.filter(isPlanWriteInput);
  const fromInput = planWrites
    .map((chunk) => extractPath(chunk.input))
    .filter(Boolean)
    .at(-1);
  if (fromInput) return fromInput;
  const planWriteIds = new Set(planWrites.map((chunk) => chunk.toolCallId));
  for (const chunk of chunks) {
    if (chunk.type !== 'tool-output-available' || !planWriteIds.has(chunk.toolCallId)) continue;
    const fromOutput = extractPath(chunk.output);
    if (fromOutput) return fromOutput;
  }
  return null;
}

/**
 * Persisted message parts for plan mode: match streamed IPC (dedupe plan markdown + drop native PlanWrite rows).
 */
export function buildFinalPartsForPersist(
  mode: 'agent' | 'plan' | 'debug',
  collectedChunks: UIMessageChunk[],
): MessagePart[] {
  const raw = buildPartsFromChunks(collectedChunks);
  if (mode !== 'plan') return raw;
  const planText = extractCanonicalPlanTextForFilter(raw);
  return filterCanonicalPlanParts(raw, planText ?? undefined) as MessagePart[];
}
