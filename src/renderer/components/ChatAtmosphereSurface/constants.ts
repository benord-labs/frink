import { cn } from '@/lib/utils';
import { isMacOS } from '@/lib/utils/platform';

/**
 * Centred content column for a top-level Agents destination. Pairs with `ChatAtmosphereSurface`:
 * `z-10` lifts the content above that surface's `z-0` atmosphere layer.
 */
export const AGENTS_PAGE_COLUMN_CLASS =
  'relative z-10 mx-auto flex h-full min-h-0 w-full max-w-[56rem] flex-col p-4 min-[600px]:p-5';

/**
 * Header row for a page using `AGENTS_PAGE_COLUMN_CLASS`. The sidebar-reopen control is positioned
 * out of flow so a collapsed sidebar leaves no gap before the title; the macOS padding clears the
 * traffic lights for whichever element owns the window's top-left corner.
 */
export function agentsPageHeaderClass(hasSidebarTrigger: boolean): string {
  return cn(
    'drag-region flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-3 [--open-sidebar-button-position:fixed] [--open-sidebar-button-left:1rem] [--open-sidebar-button-inset:0px]',
    isMacOS() && (hasSidebarTrigger ? 'pt-3 min-[600px]:pt-2' : 'max-[599px]:pt-7'),
  );
}
