import { cn } from '@/lib/utils';

/** Primary scroll column for settings tab content (inset from main area). */
export const SETTINGS_TAB_PAGE_CLASS = cn('mx-auto w-full max-w-4xl px-6 py-8 space-y-6');

/** Wider tab column (e.g. integrations grid). */
export const SETTINGS_TAB_PAGE_WIDE_CLASS = cn('mx-auto w-full max-w-6xl px-6 py-8 space-y-6');

export const SETTINGS_TAB_TITLE_CLASS = 'text-xl font-semibold tracking-tight text-foreground';

/**
 * Plain title + description stack (no bordered card). Prefer `SettingsTabHeader` for tabs.
 */
export const SETTINGS_TAB_HEADING_STACK_CLASS = 'flex flex-col gap-1';

/**
 * Default panel — matches Details widget shell language: rounded xl, soft border, subtle fill.
 */
export const SETTINGS_PANEL_CLASS = cn(
  'rounded-xl border border-border/40 glass-card p-5 shadow-xs',
);

/** Muted / secondary blocks (empty states, system info). */
export const SETTINGS_PANEL_MUTED_CLASS = cn('rounded-xl border border-border/40 bg-muted/15 p-5');

/** Glass-aligned panel with `.unified-sidebar-glass` chrome, for surfaces already under
 * `[data-agents-page]` (settings tab content) so it reads as a translucent child of the shell. */
export const SETTINGS_GLASS_PANEL_CLASS = cn(
  'rounded-xl border border-border/35 glass-card p-5',
  'shadow-[0_1px_2px_-1px_hsl(var(--background)/0.6)]',
  'dark:border-border/50 dark:shadow-[0_0_0_1px_hsl(var(--border)/0.18)]',
);

/** List/table shell with dividers (machines, connected integrations). */
export const SETTINGS_LIST_SHELL_CLASS = cn(
  'overflow-hidden rounded-xl border border-border/40 glass-card divide-y divide-border/50',
);
