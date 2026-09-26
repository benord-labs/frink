/**
 * Find and optionally focus the chat input element within a scope.
 *
 * Searches (in order): `[data-chat-input="true"]`, `[contenteditable="true"]`,
 * then `textarea` / `input`.  When `root` is omitted the whole document
 * is searched.
 */
function findChatInput(root?: Element | Document | null): HTMLElement | null {
  const scope = root ?? document;
  return (
    (scope.querySelector('[data-chat-input="true"]') as HTMLElement) ??
    (scope.querySelector('[contenteditable="true"]') as HTMLElement) ??
    (scope.querySelector('textarea, input') as HTMLElement) ??
    null
  );
}

/** Convenience: find the chat input and focus it. Reports whether a target was found. */
export function focusChatInput(root?: Element | Document | null): boolean {
  const input = findChatInput(root);
  input?.focus();
  return input !== null;
}
