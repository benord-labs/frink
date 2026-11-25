import { Loader2, type LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../../lib/utils';

type SpinnerProps = {
  className?: string;
  icon?: LucideIcon;
  /** Accessible name; without one the spinner is decorative. */
  label?: string;
  speed?: 'normal' | 'slow';
  /** False keeps the icon still, for a paused state. */
  spinning?: boolean;
};

const SPIN_CLASS = {
  normal: 'motion-safe:animate-spin',
  slow: 'motion-safe:animate-spin-slow',
} as const;

/** Loading spinner sized by `className`. The rotation sits on an HTML box, not the svg,
 *  so the compositor can run it when the page is zoomed. The only place a spin class may live
 *  (frink/no-svg-spin). */
export function Spinner({
  className,
  icon: Icon = Loader2,
  label,
  speed = 'normal',
  spinning = true,
}: SpinnerProps): ReactElement {
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      data-spinner={spinning || undefined}
      className={cn('inline-flex shrink-0', spinning && SPIN_CLASS[speed], className)}
    >
      <Icon className="size-full" />
    </span>
  );
}
