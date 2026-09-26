import { useAtomValue } from 'jotai';
import { type RefObject, useEffect } from 'react';
import {
  chatOwnsKeyboardShortcuts,
  splitPaneChat,
} from '../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import { splitViewActivePaneIndexAtom } from '../atoms';

export function useFocusInputOnEnter(
  editorRef: RefObject<{ focus: () => void } | null>,
  splitPaneIndex?: number,
) {
  const activePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key !== 'Enter' ||
        e.shiftKey ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        !chatOwnsKeyboardShortcuts(splitPaneChat(splitPaneIndex))
      ) {
        return;
      }

      // Only the active pane should respond
      if (splitPaneIndex != null && activePaneIndex !== splitPaneIndex) {
        return;
      }

      const target = e.target as HTMLElement;

      // Don't steal Enter from the code editor (Monaco uses its own DOM structure)
      if (target.closest('[data-code-editor-panel="true"]')) {
        return;
      }

      const isInsideOverlay = target.closest(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-state="open"]',
      );
      if (isInsideOverlay) {
        return;
      }

      const activeElement = document.activeElement;
      const isInputFocused =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.getAttribute('contenteditable') === 'true' ||
        activeElement?.closest('[contenteditable="true"]');

      if (isInputFocused) {
        return;
      }

      e.preventDefault();
      editorRef.current?.focus();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editorRef, splitPaneIndex, activePaneIndex]);
}
