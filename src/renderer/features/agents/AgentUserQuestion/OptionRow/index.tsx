import { Button } from '@benord-labs/frink-primitives';
import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../../../../lib/utils';

type OptionRowProps = {
  number: string;
  isSelected: boolean;
  isFocused: boolean;
  isSubmitting: boolean;
  onSelect: () => void;
  children: ReactNode;
};

/** A listbox option row — a styled div, not a `<button>`: its markdown children (links, code-copy) can't legally nest inside one. */
export function OptionRow({
  number,
  isSelected,
  isFocused,
  isSubmitting,
  onSelect,
  children,
}: OptionRowProps) {
  const select = () => {
    if (isSubmitting) return;
    onSelect();
  };

  // The listbox scrolls; arrow-key focus must pull an off-screen row into view.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isFocused) rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [isFocused]);

  return (
    <Button
      variant="ghost"
      size="auto"
      asChild
      className={cn(
        // whitespace-normal overrides the buttonVariants base `whitespace-nowrap` so long
        // labels/descriptions wrap; min-w-0 lets the text column shrink inside the flex row.
        'w-full justify-start text-left font-normal',
        'flex items-start gap-3 p-2 text-sm rounded-md outline-hidden whitespace-normal min-w-0',
        isFocused && 'bg-muted/70',
      )}
    >
      <div
        ref={rowRef}
        role="option"
        aria-selected={isSelected}
        aria-disabled={isSubmitting || undefined}
        tabIndex={isFocused ? 0 : -1}
        onClick={(e) => {
          // Nested interactive markdown (links, code-copy buttons) owns its own clicks —
          // activating it must not also select the row.
          if (e.target instanceof Element && e.target.closest('a, button')) return;
          select();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          // Shield the document-level shortcut handler even when a nested element is the
          // target — but only activate the row for its own keys, so a focused markdown link
          // keeps its native Enter behaviour.
          e.stopPropagation();
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          select();
        }}
      >
        <div
          className={cn(
            'shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-medium transition-colors mt-0.5',
            isSelected ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
          )}
        >
          {number}
        </div>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">{children}</div>
      </div>
    </Button>
  );
}
