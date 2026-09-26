/**
 * Parsing and pagination for sub-chat messages (array or JSON string from DB),
 * used by getSubChatMessages.
 */

export type MessageWithId = { id?: string };

/**
 * Parse messages from DB (array, JSON string, or other).
 * Returns a safe array of objects with optional id.
 */
export function parseMessages(raw: unknown): MessageWithId[] {
  if (Array.isArray(raw)) return raw as MessageWithId[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as MessageWithId[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Paginate messages: last N when beforeMessageId is undefined, else page before that id.
 */
export function paginateMessages(
  messages: MessageWithId[],
  limit: number,
  beforeMessageId: string | undefined,
): { messages: MessageWithId[]; hasMore: boolean } {
  if (beforeMessageId === undefined) {
    const slice = messages.length <= limit ? messages : messages.slice(-limit);
    return { messages: slice, hasMore: messages.length > limit };
  }
  const idx = messages.findIndex((m) => m.id === beforeMessageId);
  if (idx <= 0) return { messages: [], hasMore: false };
  const start = Math.max(0, idx - limit);
  const slice = messages.slice(start, idx);
  return { messages: slice, hasMore: start > 0 };
}
