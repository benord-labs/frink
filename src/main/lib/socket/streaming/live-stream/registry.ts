import { randomUUID } from 'node:crypto';
import type { TranscriptTerminalDurability } from '../../../../../shared/types/assistant-message';
import { getWriteGeneration } from '../../../db/repos/sub-chat-mutex';
import { keepsProjectedParts, keepsTerminalParts } from './terminal-parts';

import {
  getExecutionOwner,
  getExecutionStreamEpoch,
  listActiveExecutionHeaders,
} from '../execution-registry';

import type { LiveStreamRecord, LiveStreamSeed, LiveStreamTerminal } from './types';
import { publishSessionCompletion } from './completion-events';
export type { LiveStreamSeed, LiveStreamTerminal } from './types';

const TERMINAL_TTL_MS = 60_000;
const TERMINAL_RECORD_LIMIT = 64;
const NON_DURABLE = { durability: 'non-durable' } as const;
const records = new Map<string, LiveStreamRecord>();
const currentRecordKeys = new Map<string, string>();
function presentationKey(subChatId: string, assistantMessageId: string): string {
  return JSON.stringify([subChatId, assistantMessageId]);
}

function recordKey(subChatId: string, assistantMessageId: string, streamEpoch: string): string {
  return JSON.stringify([subChatId, assistantMessageId, streamEpoch]);
}

function deleteRecord(key: string): void {
  const record = records.get(key);
  records.delete(key);
  if (!record) return;
  const keyForPresentation = presentationKey(record.subChatId, record.assistantMessageId);
  if (currentRecordKeys.get(keyForPresentation) === key)
    currentRecordKeys.delete(keyForPresentation);
}

function pruneTerminals(now = Date.now()): void {
  const terminals: Array<[string, LiveStreamRecord]> = [];
  for (const [key, record] of records) {
    if (record.status !== 'settled' && record.status !== 'error') continue;
    if ((record.settledAt ?? 0) + TERMINAL_TTL_MS <= now) deleteRecord(key);
    else terminals.push([key, record]);
  }
  const over = terminals.length - TERMINAL_RECORD_LIMIT;
  if (over <= 0) return;
  const oldestFirst = terminals.sort((a, b) => (a[1].settledAt ?? 0) - (b[1].settledAt ?? 0));
  for (const [key] of oldestFirst.slice(0, over)) deleteRecord(key);
}

function existingRecord(
  subChatId: string,
  assistantMessageId: string,
): LiveStreamRecord | undefined {
  const key = currentRecordKeys.get(presentationKey(subChatId, assistantMessageId));
  return key ? records.get(key) : undefined;
}

function exactRecord(
  subChatId: string,
  assistantMessageId: string,
  streamEpoch: string,
): LiveStreamRecord | undefined {
  return records.get(recordKey(subChatId, assistantMessageId, streamEpoch));
}

export function resolveLiveStreamEpoch(subChatId: string, assistantMessageId: string): string {
  const executionEpoch = getExecutionStreamEpoch(subChatId, assistantMessageId);
  if (executionEpoch) return executionEpoch;
  const existing = existingRecord(subChatId, assistantMessageId);
  if (existing && existing.status !== 'settled' && existing.status !== 'error') {
    return existing.streamEpoch;
  }
  return randomUUID();
}

export function isLiveStreamEpochCurrent(
  subChatId: string,
  assistantMessageId: string,
  streamEpoch: string,
): boolean {
  const activeEpoch = getExecutionStreamEpoch(subChatId, assistantMessageId);
  if (activeEpoch && activeEpoch !== streamEpoch) return false;
  const existing = existingRecord(subChatId, assistantMessageId);
  return !existing || existing.streamEpoch === streamEpoch;
}

export function canRecordLiveStreamChunk(input: {
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  wakeBurst?: boolean;
}): boolean {
  if (!isLiveStreamEpochCurrent(input.subChatId, input.assistantMessageId, input.streamEpoch))
    return false;
  const previous = exactRecord(input.subChatId, input.assistantMessageId, input.streamEpoch);
  const mayResumeHold = previous?.status === 'held' && input.wakeBurst === true;
  return !previous || previous.status === 'active' || mayResumeHold;
}

const TEXT_CLOSE_CHUNK_TYPES = new Set(['text-start', 'text-end', 'start-step']);

function isRootToolInput(value: { type?: unknown; toolCallId?: unknown } | undefined): boolean {
  return (
    value?.type === 'tool-input-available' &&
    typeof value.toolCallId === 'string' &&
    !value.toolCallId.includes(':')
  );
}

function nextTextOpen(previous: boolean, chunk: unknown): boolean {
  const value = chunk as { type?: unknown; toolCallId?: unknown; delta?: unknown } | undefined;
  if (value?.type === 'text-delta') {
    return previous || (typeof value.delta === 'string' && value.delta.length > 0);
  }
  if (typeof value?.type === 'string' && TEXT_CLOSE_CHUNK_TYPES.has(value.type)) return false;
  if (isRootToolInput(value)) return false;
  return previous;
}

export function getLiveStreamGeneration(sub: string, msg: string, epoch: string) {
  return exactRecord(sub, msg, epoch)?.generation;
}

export function recordLiveStreamStart(input: {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
}): void {
  pruneTerminals();
  const keyForPresentation = presentationKey(input.subChatId, input.assistantMessageId);
  const previousKey = currentRecordKeys.get(keyForPresentation);
  const previous = previousKey ? records.get(previousKey) : undefined;
  if (previousKey && previous?.status === 'active') records.delete(previousKey);
  const key = recordKey(input.subChatId, input.assistantMessageId, input.streamEpoch);
  records.set(key, {
    ...input,
    generation: getWriteGeneration(input.subChatId), // even a zero-chunk turn's finalize is fenced
    messageIndex: -1,
    parts: [],
    textOpen: false,
    deliveryOwnerWebContentsId: getExecutionOwner(input.subChatId),
    status: 'active',
  });
  currentRecordKeys.set(keyForPresentation, key);
}

export function recordLiveStreamChunk(input: {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  messageIndex: number;
  parts?: unknown[];
  chunk: unknown;
  wakeBurst?: boolean;
}): boolean {
  pruneTerminals();
  if (!canRecordLiveStreamChunk(input)) return false;
  const key = recordKey(input.subChatId, input.assistantMessageId, input.streamEpoch);
  const previous = records.get(key);
  const sameEpoch = previous?.streamEpoch === input.streamEpoch ? previous : undefined;
  records.set(key, {
    chatId: input.chatId,
    subChatId: input.subChatId,
    assistantMessageId: input.assistantMessageId,
    streamEpoch: input.streamEpoch,
    // Carried only. Minting here would hand a pruned epoch's late chunk the CURRENT generation,
    // which is the fail-open this fence exists to prevent; recordLiveStreamStart is the only mint.
    completionSignal: sameEpoch?.completionSignal,
    generation: sameEpoch?.generation,
    messageIndex: input.messageIndex,
    parts: input.parts ?? sameEpoch?.parts,
    textOpen: nextTextOpen(sameEpoch?.textOpen ?? false, input.chunk),
    deliveryOwnerWebContentsId: getExecutionOwner(input.subChatId),
    status: 'active',
  });
  currentRecordKeys.set(presentationKey(input.subChatId, input.assistantMessageId), key);
  return true;
}

export function beginLiveStreamCompletion(input: {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  finalParts?: unknown[];
  continuesWakeHold: boolean;
  observerOwned?: boolean;
}): boolean | undefined {
  pruneTerminals();
  if (!isLiveStreamEpochCurrent(input.subChatId, input.assistantMessageId, input.streamEpoch)) {
    return undefined;
  }
  const key = recordKey(input.subChatId, input.assistantMessageId, input.streamEpoch);
  const previous = records.get(key);
  if (
    previous?.streamEpoch === input.streamEpoch &&
    (previous.status === 'settled' || previous.status === 'error')
  ) {
    return undefined;
  }
  const owner = previous ? previous.deliveryOwnerWebContentsId : getExecutionOwner(input.subChatId);
  const observerOwned = previous
    ? previous.deliveryOwnerWebContentsId === undefined
    : (input.observerOwned ?? owner === undefined);
  records.set(key, {
    chatId: input.chatId,
    subChatId: input.subChatId,
    assistantMessageId: input.assistantMessageId,
    streamEpoch: input.streamEpoch,
    completionSignal: previous?.completionSignal,
    generation: previous?.generation,
    messageIndex: previous?.streamEpoch === input.streamEpoch ? previous.messageIndex : -1,
    finalParts: input.finalParts,
    parts: input.finalParts ?? previous?.parts,
    textOpen: false,
    deliveryOwnerWebContentsId: observerOwned ? undefined : owner,
    status: input.continuesWakeHold ? 'held' : 'settling',
  });
  currentRecordKeys.set(presentationKey(input.subChatId, input.assistantMessageId), key);
  return observerOwned;
}

export function markLiveStreamCompletionFinalized(input: {
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  terminalDurability: TranscriptTerminalDurability;
}): void {
  const previous = exactRecord(input.subChatId, input.assistantMessageId, input.streamEpoch);
  if (!previous || (previous.status !== 'held' && previous.status !== 'settling')) return;
  if (input.terminalDurability.durability === 'non-durable') {
    if (!previous.terminalDurability) previous.terminalDurability = input.terminalDurability;
    return;
  }
  previous.terminalDurability = { durability: 'committed' };
}

export function armLiveStreamNotification(
  input: {
    subChatId: string;
    assistantMessageId: string;
    streamEpoch: string;
  },
  signal: AbortSignal | undefined,
): void {
  const record = exactRecord(input.subChatId, input.assistantMessageId, input.streamEpoch);
  if (record) record.completionSignal = signal;
}

export function settleLiveStreamCompletion(input: {
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  terminalDurability?: TranscriptTerminalDurability;
}): boolean {
  const key = recordKey(input.subChatId, input.assistantMessageId, input.streamEpoch);
  const previous = records.get(key);
  if (!previous || previous.streamEpoch !== input.streamEpoch || previous.status !== 'settling') {
    return false;
  }
  const terminalDurability = input.terminalDurability ?? previous.terminalDurability ?? NON_DURABLE;
  records.set(key, {
    ...previous,
    parts:
      terminalDurability.durability === 'non-durable'
        ? (previous.finalParts ?? previous.parts)
        : undefined,
    finalParts: undefined,
    status: 'settled',
    terminalDurability,
    settledAt: Date.now(),
  });
  if (
    previous.completionSignal &&
    !previous.completionSignal.aborted &&
    terminalDurability.durability === 'committed' &&
    isLiveStreamEpochCurrent(input.subChatId, input.assistantMessageId, input.streamEpoch)
  ) {
    publishSessionCompletion({ chatId: previous.chatId, subChatId: previous.subChatId });
  }
  pruneTerminals();
  return true;
}

export function recordLiveStreamError(input: {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  error?: string;
  category?: string;
  terminalDurability: TranscriptTerminalDurability;
}): boolean {
  const exact = exactRecord(input.subChatId, input.assistantMessageId, input.streamEpoch);
  const exactFinalizationPending = exact?.status === 'settling' || exact?.status === 'held';
  if (
    !exactFinalizationPending &&
    !isLiveStreamEpochCurrent(input.subChatId, input.assistantMessageId, input.streamEpoch)
  ) {
    return false;
  }
  const key = recordKey(input.subChatId, input.assistantMessageId, input.streamEpoch);
  const previous = exact;
  records.set(key, {
    chatId: input.chatId,
    subChatId: input.subChatId,
    assistantMessageId: input.assistantMessageId,
    streamEpoch: input.streamEpoch,
    generation: previous?.generation,
    messageIndex: previous?.streamEpoch === input.streamEpoch ? previous.messageIndex : -1,
    parts: previous?.streamEpoch === input.streamEpoch ? previous.parts : undefined,
    textOpen: false,
    status: 'error',
    error: input.error?.slice(0, 4_000),
    category: input.category,
    terminalDurability: input.terminalDurability,
    settledAt: Date.now(),
  });
  const keyForPresentation = presentationKey(input.subChatId, input.assistantMessageId);
  const currentKey = currentRecordKeys.get(keyForPresentation);
  if (!currentKey || currentKey === key) currentRecordKeys.set(keyForPresentation, key);
  pruneTerminals();
  return true;
}

export function releaseLiveStreamOwnershipForWebContents(webContentsId: number): void {
  for (const record of records.values()) {
    if (record.deliveryOwnerWebContentsId === webContentsId) {
      record.deliveryOwnerWebContentsId = undefined;
    }
  }
}

export function finishHeldLiveStreams(subChatId: string): Array<{
  assistantMessageId: string;
  streamEpoch: string;
  terminalDurability?: TranscriptTerminalDurability;
}> {
  const finished: Array<{
    assistantMessageId: string;
    streamEpoch: string;
    terminalDurability?: TranscriptTerminalDurability;
  }> = [];
  for (const [key, record] of records) {
    if (record.subChatId !== subChatId || record.status !== 'held') continue;
    finished.push({
      assistantMessageId: record.assistantMessageId,
      streamEpoch: record.streamEpoch,
      terminalDurability: record.terminalDurability,
    });
    // The transport owns the settlement notification. Leave both durable and not-yet-durable
    // records visible as settling until that exact epoch is either broadcast or fails finalize.
    records.set(key, { ...record, status: 'settling' });
  }
  pruneTerminals();
  return finished;
}

export function listLiveStreamHeaders(): Array<{
  subChatId: string;
  assistantMessageId?: string;
  streamEpoch: string;
}> {
  pruneTerminals();
  const result = new Map<
    string,
    { subChatId: string; assistantMessageId?: string; streamEpoch: string }
  >();
  const visibleRecords = [...records.values()].filter(
    (record) => record.status === 'active' || record.status === 'settling',
  );
  // Hydration consumes headers in order. Retire retained historical epochs before the current
  // presentation epoch so the renderer cannot mistake an older finalize for the replacement.
  for (const record of visibleRecords) {
    if (isCurrentRecord(record)) continue;
    result.set(record.streamEpoch, {
      subChatId: record.subChatId,
      assistantMessageId: record.assistantMessageId,
      streamEpoch: record.streamEpoch,
    });
  }
  for (const header of listActiveExecutionHeaders()) {
    const record = header.assistantMessageId
      ? existingRecord(header.subChatId, header.assistantMessageId)
      : undefined;
    if (
      record?.streamEpoch === header.streamEpoch &&
      record.status !== 'active' &&
      record.status !== 'settling'
    ) {
      continue;
    }
    result.set(header.streamEpoch, {
      subChatId: header.subChatId,
      assistantMessageId: header.assistantMessageId,
      streamEpoch: header.streamEpoch,
    });
  }
  for (const record of visibleRecords) {
    if (!isCurrentRecord(record)) continue;
    result.set(record.streamEpoch, {
      subChatId: record.subChatId,
      assistantMessageId: record.assistantMessageId,
      streamEpoch: record.streamEpoch,
    });
  }
  return [...result.values()];
}

function isCurrentRecord(record: LiveStreamRecord): boolean {
  return (
    currentRecordKeys.get(presentationKey(record.subChatId, record.assistantMessageId)) ===
    recordKey(record.subChatId, record.assistantMessageId, record.streamEpoch)
  );
}

function terminalProjection(
  record: LiveStreamRecord,
  includeParts: boolean,
): LiveStreamTerminal | null {
  if (record.status !== 'settled' && record.status !== 'error') return null;
  const terminalDurability = record.terminalDurability ?? ({ durability: 'non-durable' } as const);
  return {
    subChatId: record.subChatId,
    assistantMessageId: record.assistantMessageId,
    streamEpoch: record.streamEpoch,
    status: record.status,
    ...terminalDurability,
    ...(record.error ? { error: record.error } : {}),
    ...(record.category ? { category: record.category } : {}),
    // Checked at READ time, not when the terminal was written: a rollback that lands afterwards
    // must not keep serving parts whose transcript is gone (see terminal-parts.ts).
    parts:
      includeParts && keepsTerminalParts(record) && record.parts
        ? structuredClone(record.parts)
        : undefined,
  };
}

function streamProjection(record: LiveStreamRecord, includeParts: boolean): LiveStreamSeed {
  return {
    chatId: record.chatId,
    subChatId: record.subChatId,
    assistantMessageId: record.assistantMessageId,
    streamEpoch: record.streamEpoch,
    messageIndex: record.messageIndex,
    parts:
      includeParts && keepsProjectedParts(record)
        ? structuredClone(record.finalParts ?? record.parts ?? [])
        : [],
    textOpen: record.textOpen,
    status: record.status as LiveStreamSeed['status'],
    observerOwned: record.deliveryOwnerWebContentsId === undefined,
  };
}

export function getLiveStreamSeed(subChatId: string): {
  streams: LiveStreamSeed[];
  terminals: LiveStreamTerminal[];
} {
  pruneTerminals();
  const streams: LiveStreamSeed[] = [];
  const terminals: LiveStreamTerminal[] = [];
  for (const record of records.values()) {
    if (record.subChatId !== subChatId) continue;
    const current = isCurrentRecord(record);
    const terminal = terminalProjection(record, current);
    if (terminal) {
      terminals.push(terminal);
      continue;
    }
    streams.push(streamProjection(record, current));
  }
  return { streams, terminals };
}

export function _clearLiveStreamRegistryForTests(): void {
  records.clear();
  currentRecordKeys.clear();
}
