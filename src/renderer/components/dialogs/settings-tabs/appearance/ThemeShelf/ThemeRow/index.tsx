import type { ReactElement, ReactNode } from 'react';
import type { Theme } from '@/lib/themes/palette/built-in-themes';
import type { ThemeHalves } from '@/lib/themes/palette/resolve';
import type { Appearance, Palette } from '@/lib/themes/palette/roles';
import { cn } from '@/lib/utils';
import { ThemeStrip } from '../../ThemeStrip';

/** Name, Light strip, Dark strip, ⋯: shared by the list's column heads and rows. */
export const SHELF_GRID_CLASS =
  'grid grid-cols-[minmax(0,1fr)_132px_132px_28px] items-center gap-x-4 pr-3 pl-[18px]';

const APPEARANCES: readonly Appearance[] = ['light', 'dark'];

type Props = {
  theme: Theme;
  palettes: Record<Appearance, Palette | null>;
  /** Which theme paints each appearance now. */
  owners: ThemeHalves;
  /** No appearance means both. */
  onUse: (appearance?: Appearance) => void;
  menu: ReactNode;
};

/**
 * One theme in the list. The name button stretches over the whole row and uses the theme in both
 * appearances; each strip, layered above it, uses it for just that appearance.
 */
export function ThemeRow({ theme, palettes, owners, onUse, menu }: Props): ReactElement {
  const both = owners.light === theme.id && owners.dark === theme.id;
  return (
    <div
      className={cn(
        SHELF_GRID_CLASS,
        'group/row relative h-14 transition-colors duration-150 hover:bg-foreground/3.5 motion-reduce:transition-none',
        both && 'bg-foreground/5',
      )}
    >
      <div className="min-w-0">
        <button
          type="button"
          aria-pressed={both}
          aria-label={`Use ${theme.name} in light and dark`}
          onClick={() => onUse()}
          className="block max-w-full truncate rounded-sm text-left text-sm font-medium italic tracking-tight text-foreground outline-hidden after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
        >
          {theme.name}
        </button>
        <p className="truncate text-xs text-muted-foreground">
          {theme.description ?? 'Made by you.'}
        </p>
      </div>
      {APPEARANCES.map((appearance) => (
        <ThemeStrip
          key={appearance}
          as="button"
          palette={palettes[appearance]}
          on={owners[appearance] === theme.id}
          aria-pressed={owners[appearance] === theme.id}
          aria-label={`Use ${theme.name} for ${appearance}`}
          onClick={() => onUse(appearance)}
          className="relative z-10"
        />
      ))}
      {/* Kept visible while its menu is open, which moves focus out of the row. */}
      <div className="relative z-10 opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-[state=open]:opacity-100 motion-reduce:transition-none">
        {menu}
      </div>
    </div>
  );
}
