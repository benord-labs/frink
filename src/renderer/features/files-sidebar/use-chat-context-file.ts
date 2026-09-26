/**
 * Shared hook for per-chat context file tracking.
 * Used by both FilesSidebar (single-pane) and PaneFileTree (split-view)
 * to set the active file context for a specific chat panel.
 */

import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import { chatContextFileAtomFamily } from '@/lib/code-editor/state';

const GLOBAL_FALLBACK_KEY = '__global__';

/**
 * Returns a setter that updates the per-chat context file atom.
 * When `chatId` is undefined the atom uses a `__global__` key — this is
 * expected (e.g. FilesSidebar before a chat is selected).
 */
export function useChatContextFile(chatId: string | undefined, _componentName: string) {
  const setChatContextFile = useSetAtom(chatContextFileAtomFamily(chatId ?? GLOBAL_FALLBACK_KEY));

  /** Set the context file from a file path (derives name automatically). */
  const setContextFileFromPath = useCallback(
    (filePath: string) => {
      const fileName = filePath.split('/').pop() ?? filePath;
      setChatContextFile({ path: filePath, name: fileName });
    },
    [setChatContextFile],
  );

  return { setContextFileFromPath };
}
