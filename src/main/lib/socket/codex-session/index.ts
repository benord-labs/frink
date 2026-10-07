import log from 'electron-log';

// Provider session cache: subChatId → sessionId for native resume on follow-up messages.
// Capped to prevent unbounded growth over long-running sessions.
const codexSessionCache = new Map<string, string>();
const codexSessionParentChat = new Map<string, string>();
const SESSION_CACHE_MAX = 100;
// Live turns per chat: a chat-wide clear marks them, so their later cache write is dropped.
const liveTurns = new Map<string, Set<CodexTurnToken>>();

/** A turn's claim on the cache; `cleared` flips when its chat is cleared mid-turn. */
export type CodexTurnToken = { readonly chatId: string; cleared: boolean };

/** The cached Codex resume thread for a sub-chat, if any. */
export function getCodexSession(subChatId: string): string | undefined {
  return codexSessionCache.get(subChatId);
}

/** Register a turn before its first await; release it with endCodexTurn when the turn ends. */
export function beginCodexTurn(chatId: string): CodexTurnToken {
  const token: CodexTurnToken = { chatId, cleared: false };
  const turns = liveTurns.get(chatId) ?? new Set<CodexTurnToken>();
  turns.add(token);
  liveTurns.set(chatId, turns);
  return token;
}

/** Release a turn registered by beginCodexTurn. */
export function endCodexTurn(token: CodexTurnToken): void {
  const turns = liveTurns.get(token.chatId);
  if (!turns) return;
  turns.delete(token);
  if (turns.size === 0) liveTurns.delete(token.chatId);
}

/** Clear the cached Codex resume thread for a chat (e.g., when the chat is deleted). */
export function clearCodexSession(chatId: string): void {
  for (const turn of liveTurns.get(chatId) ?? []) turn.cleared = true;
  for (const [subChatId, parentChatId] of codexSessionParentChat.entries()) {
    if (parentChatId !== chatId) continue;
    codexSessionParentChat.delete(subChatId);
    codexSessionCache.delete(subChatId);
  }
}

/** Clear one sub-chat's cached Codex resume thread (e.g., after a rollback discards it). */
export function clearCodexSubChatSession(subChatId: string): void {
  codexSessionCache.delete(subChatId);
  codexSessionParentChat.delete(subChatId);
}

/** Cache a Codex resume thread, evicting the oldest entry if at capacity. LRU: delete-then-set refreshes insertion order.
 * A write from a `turn` whose chat was cleared mid-turn is dropped. */
export function setCodexSession(
  chatId: string,
  subChatId: string,
  sessionId: string,
  turn?: CodexTurnToken,
): void {
  if (turn?.cleared) {
    log.info(
      `[Socket Executor] Dropped Codex session write for cleared chat (subChatId=${subChatId})`,
    );
    return;
  }
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
