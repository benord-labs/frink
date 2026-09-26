import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';
import { withViewTransition } from '@/lib/themes/preview/theme-actions';
import { cn } from '@/lib/utils';

const MODES = [
  { value: 'system', label: 'Match computer', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const;

// Raised segment; forced colours drop its shadow and paint the transparent outline instead.
const RAISED_CLASS =
  'bg-background font-medium text-foreground shadow-[0_0_0_0.5px_hsl(var(--border)),0_1px_2px_rgb(0_0_0/0.14),inset_0_1px_0_hsl(var(--foreground)/0.06)] outline-1 outline-transparent';

const ARROW_STEPS = new Map([
  ['ArrowRight', 1],
  ['ArrowDown', 1],
  ['ArrowLeft', -1],
  ['ArrowUp', -1],
]);

/** Match computer / Light / Dark as a radio group: arrows move the pick, Tab leaves the group. */
export function ModeSwitch(): ReactElement {
  const { theme, setTheme } = useTheme();
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const checked = Math.max(
    0,
    MODES.findIndex((mode) => mode.value === theme),
  );
  const pick = (index: number) => withViewTransition(() => setTheme(MODES[index].value));

  // Steps from the focused radio: `checked` lags a pick until its view transition updates.
  const onKeyDown = (event: KeyboardEvent, from: number) => {
    const step = ARROW_STEPS.get(event.key);
    if (step === undefined) return;
    event.preventDefault();
    const next = (from + step + MODES.length) % MODES.length;
    pick(next);
    radios.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Light or dark"
      className="track-recess inline-flex shrink-0 gap-0.5 self-start rounded-[10px] bg-input-background p-[3px]"
    >
      {MODES.map(({ value, label, Icon }, index) => (
        <button
          key={value}
          ref={(radio) => {
            radios.current[index] = radio;
          }}
          type="button"
          role="radio"
          aria-checked={index === checked}
          tabIndex={index === checked ? 0 : -1}
          onClick={() => pick(index)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[13px] whitespace-nowrap transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            index === checked ? RAISED_CLASS : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
