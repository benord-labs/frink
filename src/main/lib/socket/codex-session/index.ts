import log from 'electron-log';

// Provider session cache: subChatId → sessionId for native resume on follow-up messages.
// Capped to prevent unbounded growth over long-running sessions.
const codexSessionCache = new Map<string, string>();
const codexSessionParentChat = new Map<string, string>();
const SESSION_CACHE_MAX = 100;

/** The cached Codex resume thread for a sub-chat, if any. */
export function getCodexSession(subChatId: string): string | undefined {
  return codexSessionCache.get(subChatId);
}

/** Clear the cached Codex resume thread for a chat (e.g., when the chat is deleted). */
export function clearCodexSession(chatId: string): void {
  for (const [subChatId, parentChatId] of codexSessionParentChat.entries()) {
    if (parentChatId !== chatId) continue;
    codexSessionParentChat.delete(subChatId);
    codexSessionCache.delete(subChatId);
  }
}

/** Cache a Codex resume thread, evicting the oldest entry if at capacity. LRU: delete-then-set refreshes insertion order. */
export function setCodexSession(chatId: string, subChatId: string, sessionId: string): void {
  const sizeBefore = codexSessionCache.size;
  codexSessionCache.delete(subChatId); // Refresh insertion order for LRU
  if (codexSessionCache.size >= SESSION_CACHE_MAX) {
    const oldest = codexSessionCache.keys().next().value;
    if (oldest) {
      codexSessionCache.delete(oldest);
      codexSessionParentChat.delete(oldest);
      log.info(
        `[Socket Executor] Session cache eviction: removed oldest subChatId=${oldest}, inserted subChatId=${subChatId} (sizeBefore=${sizeBefore}, sizeAfterEvict=${codexSessionCache.size}, max=${SESSION_CACHE_MAX})`,
      );
    }
  }
  codexSessionParentChat.set(subChatId, chatId);
  codexSessionCache.set(subChatId, sessionId);
}
