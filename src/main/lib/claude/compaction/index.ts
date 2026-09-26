import type { UIMessageChunk } from '../types';

export { createContextUsageTracker } from './context-usage';

type CompactionMessage = {
  subtype?: string;
  status?: string;
  compact_result?: 'success' | 'failed';
  compact_metadata?: { trigger?: 'manual' | 'auto' };
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
 */
export function createCompactionMapper(): (msg: CompactionMessage) => UIMessageChunk[] {
  let openId: string | null = null;
  let counter = 0;

  return (msg) => {
    if (msg.subtype === 'status' && msg.status === 'compacting') {
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
    if (msg.subtype === 'compact_boundary')
      return close({ state: 'output-available', trigger: msg.compact_metadata?.trigger });
    return [];
  };
}
