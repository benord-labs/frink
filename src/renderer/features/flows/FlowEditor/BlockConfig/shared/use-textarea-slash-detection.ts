import {
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useRef,
  useState,
} from 'react';
import { getTextareaCaretViewportPosition } from './get-textarea-caret-viewport';

type SlashState =
  | { active: false }
  | { active: true; query: string; slashStart: number; position: { top: number; left: number } };

const INACTIVE: SlashState = { active: false };

const SLASH_TRIGGER_RE = /(?:^|\n)(\/\S*)$/;

const CARET_MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * Detects `/command` triggers in a plain `<textarea>` and tracks state for a slash
 * command dropdown. Matches `/word` at line start or after a newline (same idea as
 * the rich-text editor slash detection).
 *
 * **Wire-up:** On your `<Textarea>`, set `ref={textareaRef}`, `onChange={handleTextChange}`,
 * `onKeyDown={handleKeyDown}`, and `onSelect={handleTextareaSelect}`. Slash position uses
 * `selectionStart` and caret viewport coordinates from a layout mirror. The ref links this
 * hook to that DOM node for React.
 *
 * @returns `textareaRef` (bind with `ref={...}`), `slashState`, `handleTextChange`,
 * `handleKeyDown`, `handleTextareaSelect`, and `closeSlash`.
 */
export function useTextareaSlashDetection(onChange: (value: string) => void) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashState, setSlashState] = useState<SlashState>(INACTIVE);

  const applySlashDetection = useCallback((textarea: HTMLTextAreaElement) => {
    const value = textarea.value;
    const cursor = textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = SLASH_TRIGGER_RE.exec(before);
    if (match) {
      const caret = getTextareaCaretViewportPosition(textarea, cursor);
      setSlashState({
        active: true,
        query: match[1].slice(1),
        slashStart: cursor - match[1].length,
        position: { top: caret.top, left: caret.left },
      });
    } else {
      setSlashState(INACTIVE);
    }
  }, []);

  const handleTextChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      applySlashDetection(e.target);
    },
    [onChange, applySlashDetection],
  );

  const handleTextareaSelect = useCallback(
    (e: SyntheticEvent<HTMLTextAreaElement>) => {
      applySlashDetection(e.currentTarget);
    },
    [applySlashDetection],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape' && slashState.active) {
        e.stopPropagation();
        setSlashState(INACTIVE);
        return;
      }
      if (slashState.active && CARET_MOVE_KEYS.has(e.key)) {
        const el = e.currentTarget;
        queueMicrotask(() => applySlashDetection(el));
      }
    },
    [slashState.active, applySlashDetection],
  );

  const closeSlash = useCallback(() => setSlashState(INACTIVE), []);

  return {
    textareaRef,
    slashState,
    handleTextChange,
    handleKeyDown,
    handleTextareaSelect,
    closeSlash,
  };
}
