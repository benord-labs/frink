import { useAtomValue } from 'jotai';
import { type RefObject, useEffect } from 'react';
import {
  chatOwnsKeyboardShortcuts,
  splitPaneChat,
} from '../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import { splitViewActivePaneIndexAtom } from '../atoms';

export function useToggleFocusOnCmdEsc(
  editorRef: RefObject<{ focus: () => void; blur: () => void } | null>,
  splitPaneIndex?: number,
) {
  const activePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key !== 'Escape' ||
        !(e.metaKey || e.ctrlKey) ||
        e.shiftKey ||
        e.altKey ||
        !chatOwnsKeyboardShortcuts(splitPaneChat(splitPaneIndex))
      ) {
        return;
      }

      if (splitPaneIndex != null && activePaneIndex !== splitPaneIndex) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const editor = editorRef.current;
      if (!editor) return;

      const activeElement = document.activeElement;
      const isInputFocused =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.getAttribute('contenteditable') === 'true' ||
        (activeElement?.hasAttribute('contenteditable') &&
          activeElement.getAttribute('contenteditable') !== 'false');

      if (isInputFocused) {
        editor.blur();
      } else {
        editor.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [editorRef, splitPaneIndex, activePaneIndex]);
}
