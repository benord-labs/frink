import { cn } from '@/lib/utils';

type PanelTabTextSize = 'xs' | 'sm';

/** Active / inactive tab chip — matches unified sidebar / Files sidebar (no primary pill). */
export function panelTabButtonClass(isActive: boolean, textSize: PanelTabTextSize = 'xs'): string {
  return cn(
    'rounded-md px-2.5 py-1 font-medium transition-colors border',
    textSize === 'xs' ? 'text-xs' : 'text-sm',
    isActive
      ? 'border-border/35 bg-foreground/10 text-foreground shadow-xs'
      : 'border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
  );
}
