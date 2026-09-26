import { useAtom } from 'jotai';
import { useEffect } from 'react';
import { focusedDiffFileAtomFamily } from '../../atoms';
import { findDiffFileByPath } from '../../utils/diff/diff-code-view-items';

/** Serves the chat's Edit-card focus request: expands that file, then scrolls it into view. */
export function useFocusedDiffFile(
  chatId: string,
  files: readonly { key: string; path: string }[],
  onExpand: (key: string) => void,
  scrollTo: (key: string) => void,
) {
  const [focusedPath, setFocusedPath] = useAtom(focusedDiffFileAtomFamily(chatId));

  // A request only lives while the panel is open, so a file that never appears is dropped
  useEffect(() => () => setFocusedPath(null), [setFocusedPath]);

  useEffect(() => {
    if (!focusedPath) return;
    const file = findDiffFileByPath(files, focusedPath);
    // Keep the request until its file is in the diff; the refresh that adds it re-runs this
    if (!file) return;
    setFocusedPath(null);
    onExpand(file.key);
    requestAnimationFrame(() => scrollTo(file.key));
  }, [focusedPath, files, onExpand, scrollTo, setFocusedPath]);
}
