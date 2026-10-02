import type { UIMessageChunk } from '../types';

export { createContextUsageTracker } from './context-usage';

type CompactionMessage = {
  type?: string;
  subtype?: string;
  status?: string;
  isReplay?: boolean;
  message?: { content?: unknown };
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
 */
export function createCompactionMapper(): (raw: unknown) => UIMessageChunk[] {
  let openId: string | null = null;
  let counter = 0;
  // The settled card still awaiting its summary: the SDK streams it as the next user message.
  let settled: { id: string; data: CompactData } | null = null;

  // A user or assistant message only ever completes (or abandons) the settled card's summary.
  const attachSummary = (msg: CompactionMessage): UIMessageChunk[] => {
    const summary = msg.type === 'user' && !msg.isReplay ? summaryText(msg.message?.content) : null;
    if (!settled || (msg.type === 'user' && !summary)) return [];
    const { id, data } = settled;
    settled = null;
    return summary ? [{ type: 'data-compact', id, data: { ...data, summary } }] : [];
  };

  return (raw) => {
    // SAFETY: every field read below is optional and checked before use.
    const msg = (raw && typeof raw === 'object' ? raw : {}) as CompactionMessage;
    if (msg.type === 'user' || msg.type === 'assistant') return attachSummary(msg);
    if (msg.subtype === 'status' && msg.status === 'compacting') {
      settled = null;
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
      const data = boundaryData(msg.compact_metadata);
      settled = { id, data };
      return close(data);
    }
    return [];
  };
}

function boundaryData(meta: CompactionMessage['compact_metadata']): CompactData {
  const data: CompactData = { state: 'output-available', trigger: meta?.trigger };
  // The SDK kept some pre-boundary messages verbatim, so the summary is not the whole context.
  if (meta?.preserved_segment || meta?.preserved_messages) data.partial = true;
  return data;
}

/** The text of a plain user message; null for tool results, which never carry the summary. */
function summaryText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  if (content.some((block) => block?.type === 'tool_result')) return null;
  const text = content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();
  return text || null;
}
