/** Shared layout tokens for the centered Add step dialog. */

import { cn } from '../../../../lib/utils';

export const NODE_CREATOR_SHEET_SURFACE_CLASS = cn(
  'flex h-[min(680px,calc(100vh-2rem))] w-[min(720px,calc(100vw-2rem))]',
  'max-h-none max-w-none flex-col gap-0 overflow-hidden rounded-xl',
  'p-0 shadow-[0_4px_12px_rgba(0,0,0,0.15)]',
  'motion-reduce:animate-none motion-reduce:transition-none',
);

export const NODE_CREATOR_SEARCH_INPUT_CLASS = cn(
  'rounded-md border-border/60 bg-muted/60 pl-9 text-foreground shadow-none',
  'placeholder:text-muted-foreground/70',
);

export const NODE_CREATOR_PANEL_BODY_CLASS = cn('flex min-h-0 flex-1 flex-col overflow-hidden');

export const NODE_CREATOR_HEADER_CLASS = cn(
  'flex shrink-0 items-start gap-3 border-b border-border/50 px-5 py-4',
);

export const NODE_CREATOR_SEARCH_WRAP_CLASS = cn(
  'relative shrink-0 border-b border-border/40 px-5 py-3',
);

export const NODE_CREATOR_TAB_RAIL_CLASS = cn(
  'shrink-0 overflow-x-auto border-b border-border/50 px-5 py-2 scrollbar-thin',
);

export const NODE_CREATOR_TABS_LIST_CLASS = cn(
  'h-8 min-w-max justify-start gap-1 rounded-none bg-transparent p-0',
);

export const NODE_CREATOR_TAB_CLASS = cn(
  'h-8 rounded-md px-2.5 py-1 text-xs font-medium shadow-none',
  'data-[state=active]:bg-muted data-[state=active]:shadow-none',
  'motion-reduce:transition-none',
);

export const NODE_CREATOR_TABS_CONTENT_CLASS = cn(
  'm-0 min-h-0 flex-1 overflow-hidden focus-visible:ring-inset',
);

export const NODE_CREATOR_SECTION_HEADER_CLASS = cn('flex h-7 w-full shrink-0 items-center px-2');

export const NODE_CREATOR_LIST_SCROLL_CLASS = cn(
  'flex h-full min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain',
  'px-5 py-3 scrollbar-thin',
);

export const NODE_CREATOR_FOOTER_CLASS = cn(
  'flex min-h-12 shrink-0 items-center justify-between gap-3',
  'border-t border-border/50 bg-muted/25 px-5 py-2',
);
