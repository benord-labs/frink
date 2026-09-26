/**
 * True when keyboard focus is already on the xterm textarea (or inside it).
 * Used to skip redundant `xterm.focus()` / rAF work when `isKeyboardTarget` flips.
 */
export function isXtermTextareaFocused(
  textarea: HTMLTextAreaElement | undefined | null,
  activeElement: Element | null,
): boolean {
  if (!textarea) return false;
  if (!activeElement) return false;
  return activeElement === textarea || textarea.contains(activeElement);
}
