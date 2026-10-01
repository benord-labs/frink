import { Plus } from 'lucide-react';
import { type ReactElement, useId } from 'react';

// Frink's diagonal as a hatch: the tile slope, 117°.
const HATCH =
  'repeating-linear-gradient(117deg, hsl(var(--foreground) / 0.09) 0 1px, transparent 1px 5px)';

type Props = {
  /** The theme on screen, which the new one starts from. */
  from: string;
  disabled?: boolean;
  onClick: () => void;
};

/** Starts a theme from the one on screen; the editor asks only for a background and an accent. */
export function NewThemeButton({ from, disabled, onClick }: Props): ReactElement {
  const hintId = useId();
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="New theme"
      aria-describedby={hintId}
      onClick={onClick}
      className="flex min-w-0 items-center gap-2.5 rounded-[9px] py-1.5 pr-2.5 pl-1.5 text-left outline-hidden transition-colors duration-150 hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
    >
      <span
        aria-hidden
        className="grid size-[30px] shrink-0 place-items-center rounded-lg text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]"
        style={{ backgroundImage: HATCH }}
      >
        <Plus className="size-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm leading-tight font-medium text-foreground">New theme</span>
        <span id={hintId} className="block text-xs leading-snug text-muted-foreground">
          Starts from {from}. Change two colors, Frink picks the rest.
        </span>
      </span>
    </button>
  );
}
