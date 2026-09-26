import { Button } from '@benord-labs/frink-primitives';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fillCommandArguments } from '../../../../../shared/commands/fill-command-arguments';
import type { SlashCommandOption } from '@/lib/commands/types';
import { overlayGlass } from '@/lib/overlay-styles';

function currentRange(): Range | null {
  const selection = window.getSelection();
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
}

function restoreRange(range: Range | null): void {
  const selection = window.getSelection();
  if (!range || !selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

type Props = {
  command: SlashCommandOption;
  style: CSSProperties;
  /** Receives the command with $ARGUMENTS filled, or null when the user backs out. */
  onResolve: (filled: SlashCommandOption | null) => void;
};

/**
 * Collects a command's arguments before it enters the composer, so the message the user types
 * afterwards can never be mistaken for them.
 */
export function CommandArgumentsPopover({ command, style, onResolve }: Props): ReactElement {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Taken during the first render, before the input below steals focus: refocusing a
  // contenteditable restores focus but not the caret, and the editor strips its trigger by caret.
  const composerCaret = useRef(currentRange());

  useEffect(() => inputRef.current?.focus(), []);

  // Abandoning the popover — Send, or a click anywhere else — has to dismiss it. The caret is
  // deliberately not restored here: the user is going somewhere else, so do not pull focus back.
  useEffect(() => {
    const dismiss = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Node && !containerRef.current?.contains(target)) onResolve(null);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [onResolve]);

  const finish = (filled: SlashCommandOption | null) => {
    restoreRange(composerCaret.current);
    onResolve(filled);
  };

  const submit = () =>
    finish({ ...command, prompt: fillCommandArguments(command.prompt ?? '', value) });

  return createPortal(
    <div
      ref={containerRef}
      style={style}
      className={`fixed z-50 rounded-lg border shadow-lg p-2.5 flex flex-col gap-2 ${overlayGlass}`}
    >
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="shrink-0 text-xs font-medium">{command.command}</span>
        <span className="text-muted-foreground truncate text-[10px]">{command.description}</span>
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          // Enter and Escape belong to the IME while it is composing, not to this field.
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') finish(null);
        }}
        placeholder={command.argumentHint?.trim() || 'Arguments for this command'}
        aria-label={`Arguments for ${command.command}`}
        className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground/70">Esc to cancel</span>
        <Button
          onMouseDown={(e) => {
            // Without this the browser refocuses the button after the caret is restored, and
            // focus lands on the body once this popover unmounts.
            e.preventDefault();
            submit();
          }}
          className="h-6 px-2 text-[11px] rounded-md"
        >
          Insert
        </Button>
      </div>
    </div>,
    document.body,
  );
}
