/**
 * Surfaces for the flow block config rail: tints inside its glass panel, never blurred (nothing
 * moves behind a panel).
 */

import { cn } from '../../../../lib/utils';

/** Inherited / display row (was flat `bg-muted/20`). */
export const BLOCK_CONFIG_FIELD_CARD_CLASS = cn(
  'flex min-w-0 w-full max-w-full items-center justify-between gap-2 rounded-lg border border-border/45 bg-card/35 px-3 py-2 shadow-xs ring-1 ring-inset ring-border/30',
);

/** Info / helper paragraphs and static callouts. */
export const BLOCK_CONFIG_CALLOUT_CLASS = cn(
  'rounded-lg border border-border/40 bg-card/40 px-3 py-2 leading-relaxed text-xs text-muted-foreground ring-1 ring-inset ring-border/25',
);

/** Stacked section (e.g. custom node “Node details”). */
export const BLOCK_CONFIG_SECTION_STACK_CLASS = cn(
  'space-y-2 rounded-lg border border-border/45 bg-card/35 px-3 py-2.5 shadow-xs ring-1 ring-inset ring-border/30',
);

/** “Available variables” collapsible shell. */
export const BLOCK_CONFIG_COLLAPSIBLE_SHELL_CLASS = cn(
  'overflow-hidden rounded-lg border border-border/40 bg-card/30 shadow-xs ring-1 ring-inset ring-border/25',
);
