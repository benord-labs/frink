import type { UIMessageChunk } from '../types';
import { compactionSummaryJoinFor } from './summary-join';

export { createContextUsageTracker } from './context-usage';
export { compactionSummaryJoinFor, createCompactionSummaryJoin } from './summary-join';

type CompactionMessage = {
  session_id?: string;
  subtype?: string;
  status?: string;
  compact_result?: 'success' | 'failed';
  compact_metadata?: {
    trigger?: 'manual' | 'auto';
    preserved_segment?: unknown;
    preserved_messages?: unknown;
  };
};

type CompactData = Extract<UIMessageChunk, { type: 'data-compact' }>['data'];

/**
 * Maps the SDK's compaction lifecycle onto the `data-compact` chunk the UI renders.
 *
 * Stateful because the SDK reports the start and the end as separate messages: only the start can
 * tell that a compaction began, and the close needs to know one is open before it may settle it.
 *
 * Three terminal paths, not two. A FAILED compaction emits no `compact_boundary`, so without the
 * `compact_result` branch the card would sit at "Compacting…" for the rest of the session —
 * `/compact` on a chat with no history is the ordinary way to reach it, not a rare edge.
 *
 * A settled boundary passes through its session's summary join, which attaches the PostCompact
 * summary (sc-2281).
 */
export function createCompactionMapper(): (msg: CompactionMessage) => UIMessageChunk[] {
  let openId: string | null = null;
  let counter = 0;

  return (msg) => {
    const summaryJoin = msg.session_id ? compactionSummaryJoinFor(msg.session_id) : undefined;
    if (msg.subtype === 'status' && msg.status === 'compacting') {
      summaryJoin?.onStart();
      openId = `compact-${Date.now()}-${counter++}`;
      return [
        { type: 'data-compact', id: openId, transient: true, data: { state: 'input-streaming' } },
      ];
    }
    if (!openId) return [];

    const id = openId;
    const close = (data: CompactData): UIMessageChunk[] => {
      openId = null;
      return [{ type: 'data-compact', id, data }];
    };

    if (msg.subtype === 'status' && msg.compact_result === 'failed')
      return close({ state: 'output-error' });
    if (msg.subtype === 'compact_boundary') {
      const meta = msg.compact_metadata;
      const settled: CompactData = { state: 'output-available', trigger: meta?.trigger };
      if (meta?.preserved_segment || meta?.preserved_messages) settled.partial = true;
      return close(summaryJoin ? summaryJoin.onSettled(id, settled) : settled);
    }
    return [];
  };
}
