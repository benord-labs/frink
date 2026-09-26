import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import type { Palette, Role } from '@/lib/themes/palette/roles';
import { cn } from '@/lib/utils';

// frink-primitives' .tile-notch slope at strip scale.
const STRIP_CUT = 'polygon(0 0, calc(100% - 12px) 0, 100% 6px, 100% 100%, 0 100%)';

const SEGMENTS: readonly [role: Role, share: number][] = [
  ['background', 40],
  ['field', 13],
  ['mutedText', 10],
  ['text', 10],
  ['accent', 27],
];

type Props = Omit<ButtonHTMLAttributes<HTMLElement>, 'children'> & {
  /** Null until stock Frink is read: the strip keeps its size, unpainted. */
  palette: Palette | null;
  as?: 'button' | 'span';
  /** `md` is the shelf's 132×30 chip; `fill` spans its container. */
  size?: 'md' | 'fill';
  /** In use: the accent ring (an outline, so forced colours keep it) and glow. */
  on?: boolean;
  /** A caption under the strip, inside the ring. */
  children?: ReactNode;
};

/** One half of a theme in its own colours, never app tokens: canvas with "Aa", then field, faded text, text and accent. */
export function ThemeStrip({
  palette,
  as = 'span',
  size = 'md',
  on = false,
  className,
  children,
  ...rest
}: Props): ReactElement {
  const Tag = as;
  return (
    <Tag
      {...rest}
      {...(as === 'button' ? { type: 'button' as const } : null)}
      className={cn(
        'group/strip flex shrink-0 flex-col gap-1.5 rounded-[9px] p-[3px] text-left transition-[box-shadow,outline-color] duration-250 ease-[cubic-bezier(.2,.8,.2,1)] focus-visible:ring-2 focus-visible:ring-foreground motion-reduce:transition-none',
        size === 'md' ? 'h-[30px] w-[132px]' : 'w-full',
        // Focus is a foreground ring outside the in-use outline; forced colours drop rings, so
        // there the outline steps out instead.
        on
          ? 'shadow-[0_0_14px_-4px_hsl(var(--primary)/0.7)] outline-[1.5px] outline-primary focus-visible:outline-offset-0 focus-visible:ring-[3.5px] forced-colors:focus-visible:outline-offset-2'
          : 'focus-visible:outline-hidden',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgb(127_127_127/0.24)] group-hover/strip:brightness-106',
          size === 'md' ? 'h-full' : 'h-[22px]',
        )}
        style={{ clipPath: STRIP_CUT }}
      >
        {palette
          ? SEGMENTS.map(([role, share]) => (
              <span
                key={role}
                className="flex items-center text-[11px] font-semibold first:pl-2"
                style={{
                  flex: `${share} 1 0`,
                  backgroundColor: palette[role],
                  color: palette.text,
                }}
              >
                {role === 'background' ? 'Aa' : null}
              </span>
            ))
          : null}
      </span>
      {children}
    </Tag>
  );
}
