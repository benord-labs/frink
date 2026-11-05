/**
 * Whether a chat's own files show under its "This chat" row, for the file tree hosts that hold it.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * The open state of the "This chat" row in `chatId`'s file tree. Each chat's tree starts open, and
 * it opens again once no other project is left, so a project added later never hides it.
 * `isHidden` reads the latest value when called, so a shortcut held by a parent that does not
 * re-render when the row toggles still sees it.
 */
export function useMainRootOpen(chatId: string | null | undefined, hasExtraRoots: boolean) {
  const key = chatId ?? '';
  // The chat whose row is closed, if any.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  if (closedFor !== null && (closedFor !== key || !hasExtraRoots)) setClosedFor(null);
  const open = closedFor !== key;
  const hidden = hasExtraRoots && !open;
  const hiddenRef = useRef(hidden);
  useLayoutEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);

  const setOpen = useCallback((next: boolean) => setClosedFor(next ? null : key), [key]);
  const isHidden = useCallback(() => hiddenRef.current, []);
  return { open, setOpen, isHidden };
}
