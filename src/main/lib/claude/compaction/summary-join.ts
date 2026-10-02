import type { UIMessageChunk } from '../types';

type CompactData = Extract<UIMessageChunk, { type: 'data-compact' }>['data'];

export interface CompactionSummaryJoin {
  /** A new compaction began: anything left from an earlier one can no longer be matched to it. */
  onStart(): void;
  /** The boundary settled: merges a summary that arrived first, else waits for one. */
  onSettled(id: string, data: CompactData): CompactData;
  /** The PostCompact hook fired: the re-emission for a boundary that settled first, else null. */
  onSummary(summary: string): { id: string; data: CompactData } | null;
}

/** Attaches the PostCompact `compact_summary` to the settled `data-compact` part, whichever of the
 * two lands second; a new compaction's start clears anything an earlier one left unmatched. */
export function createCompactionSummaryJoin(): CompactionSummaryJoin {
  let pendingSummary: string | null = null;
  let awaiting: { id: string; data: CompactData } | null = null;

  return {
    onStart() {
      pendingSummary = null;
      awaiting = null;
    },
    onSettled(id, data) {
      if (pendingSummary !== null) {
        const merged = { ...data, summary: pendingSummary };
        pendingSummary = null;
        awaiting = null;
        return merged;
      }
      awaiting = { id, data };
      return data;
    },
    onSummary(summary) {
      if (awaiting) {
        const reemit = { id: awaiting.id, data: { ...awaiting.data, summary } };
        awaiting = null;
        return reemit;
      }
      pendingSummary = summary;
      return null;
    },
  };
}

/** Recent sessions only: an entry outlives its compaction by one small object, never unbounded. */
const MAX_TRACKED_SESSIONS = 64;
const joinsBySession = new Map<string, CompactionSummaryJoin>();

/**
 * The join for one SDK session. Keyed by the session id that both the stream's compaction messages
 * and the PostCompact hook input carry, so the two meet without threading state through callers.
 */
export function compactionSummaryJoinFor(sessionId: string): CompactionSummaryJoin {
  const existing = joinsBySession.get(sessionId);
  if (existing) return existing;
  const join = createCompactionSummaryJoin();
  joinsBySession.set(sessionId, join);
  if (joinsBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = joinsBySession.keys().next().value;
    if (oldest !== undefined) joinsBySession.delete(oldest);
  }
  return join;
}
