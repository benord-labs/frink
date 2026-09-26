/**
 * Shared vocabulary for classifying a tool result as Blocked (a permission
 * denial) rather than Failed (a genuine error).
 *
 * TWO-TIER CONTRACT — read this before adding a keyword:
 *
 * 1. EXPLICIT FLAG is the contract for new messages. Producers set
 *    `output.permissionDenied` (or `output.code === 'readonly_mode'`) at the
 *    point of denial, so classification never depends on message wording.
 * 2. KEYWORD MATCHING is a bounded, read-only shim for transcripts persisted
 *    before the flag existed. Chat history stores renderer-shaped message parts
 *    verbatim and re-reads them without re-deriving state (see
 *    `main/lib/db/repos/sub-chats.ts` and `features/agents/stores/message-store.ts`),
 *    so those old parts carry no flag and this list is their only classifier.
 *    It cannot be removed without migrating stored chat history.
 *
 * A new denial path must set the explicit flag. Adding a keyword here only ever
 * changes how already-stored transcripts render — it will not classify new
 * denials that forgot the flag on any tool whose policy gates the keyword path.
 */
export const TOOL_DENIAL_KEYWORDS = [
  'denied',
  'blocked',
  'read-only',
  'requires a project context',
] as const;

/** True when `text` carries any legacy denial marker. Case-insensitive. */
export function matchesToolDenialKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return TOOL_DENIAL_KEYWORDS.some((keyword) => lower.includes(keyword));
}
