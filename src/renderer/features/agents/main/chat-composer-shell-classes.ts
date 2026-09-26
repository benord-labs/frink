import { cn } from '../../../lib/utils';

/** Elevated glass (`glass-float`, blurred) for user bubbles and inline agent cards (trigger/task).
 *  Outer shadows only: the glass rim replaces the top line. */
export function agentsChatBubbleSurfaceClass(): string {
  return cn(
    'relative rounded-2xl border border-border text-card-foreground glass-float',
    'shadow-[0_1px_2px_-1px_hsl(var(--background)/0.45)] dark:shadow-[0_0_0_1px_hsl(var(--border)/0.2)]',
    'contrast-more:border-border contrast-more:bg-input-background',
  );
}

/**
 * Composer surface: `.unified-sidebar-glass` chrome plus `glass-float`, with `chat-composer-glass`
 * (agents-styles.css) setting its border, shadow and a wider radius (1rem vs 0.75rem), and
 * `composer-slot-surface` squaring its top under a stacked card.
 */
function agentsChatComposerSurfaceClass(): string {
  return cn(
    'unified-sidebar-glass chat-composer-glass composer-slot-surface glass-float relative text-card-foreground',
  );
}

/** User message text/summary, readable over scrolling assistant content. */
export function agentsChatUserBubbleShellClass(): string {
  return cn(
    agentsChatBubbleSurfaceClass(),
    'p-3 text-sm whitespace-pre-wrap transition-all duration-200',
  );
}

/** `pl-1.5` matches the icon's inset in the 28px icon-only square ((28 - 16) / 2), so the icon
 *  stays put when a label appears or goes. */
const COMPOSER_CONTROL_BASE_CLASS =
  'h-7 gap-1.5 rounded-md pl-1.5 pr-2 text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:bg-foreground/5 hover:text-foreground';

/** Composer controls: icon + label on a wide composer, icon-only below the measured 34rem tier.
 *  Keyed on the `@container/composer` wrapper; see docs/decisions/chat-composer-narrow-pane-layout. */
export const COMPOSER_CONTROL_CLASS = `${COMPOSER_CONTROL_BASE_CLASS} shrink-0 @max-[34rem]/composer:w-7 @max-[34rem]/composer:gap-0 @max-[34rem]/composer:px-0`;
/** The text half of a control; only the icon survives below the tier. */
export const COMPOSER_CONTROL_LABEL_CLASS = 'text-sm @max-[34rem]/composer:hidden';

/** The model is the row's elastic control and its last label to go: the name holds to 260px of
 *  composer, where Opus 5 still fits beside the context ring (measured; see the decision axis). */
export const COMPOSER_MODEL_CONTROL_CLASS = `${COMPOSER_CONTROL_BASE_CLASS} min-w-0 @max-[16.25rem]/composer:w-7 @max-[16.25rem]/composer:gap-0 @max-[16.25rem]/composer:px-0`;
export const COMPOSER_MODEL_LABEL_CLASS =
  'min-w-0 truncate text-sm @max-[16.25rem]/composer:hidden';
/** Tier suffix and chevron go before the name (from 360px). chat-input-area's context chip goes
 *  `sr-only` at 34rem so it never squeezes the name, yet stays dismissable by keyboard. */
export const COMPOSER_MODEL_DETAIL_CLASS = '@max-[22.5rem]/composer:hidden';

/** Tiniest widths shed reference before controls: the context ring first, then attach. Sums of
 *  28px boxes: the icon row needs 188px with both, 158px without the ring. */
export const HIDE_CONTEXT_RING_TIER = '@max-[13.5rem]/composer:hidden';
/** `sr-only`, not `hidden`: out of the row but still in the tab order, so Tab + Enter opens the
 *  file picker at a width with no room for the button; mouse users still paste or drop. */
export const HIDE_ATTACH_TIER = '@max-[11.5rem]/composer:sr-only';

/** The toolbar's left group, shared by both composers: one line, never wrapping, and clipped so it
 *  can never paint over the send button when even the icon row does not fit. */
export const COMPOSER_ACTION_ROW_CLASS =
  'flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-hidden';

/** Composer shell: the bubbles' glass, so the transcript blurs as it scrolls under. The drop and
 *  focus rings hug the rim: a ring offset paints a solid band that cuts through the transcript. */
export function agentsChatComposerShellClass(isDragOver: boolean, isFocused: boolean): string {
  return cn(
    agentsChatComposerSurfaceClass(),
    'z-10 gap-2 p-3 transition-shadow duration-150',
    isDragOver && 'ring-2 ring-primary/45',
    isFocused && !isDragOver && 'ring-2 ring-primary/40',
  );
}
