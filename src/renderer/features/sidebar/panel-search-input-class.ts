/**
 * Search input styling for frosted glass sidebars (Unified + Files).
 * Keep in sync visually — single source for both panels.
 * Icons in the padded area must render **above** the input (`z-10` vs `relative z-0`)
 * so `backdrop-blur-xs` does not sample them as the blurred backdrop.
 */
export const SIDEBAR_PANEL_SEARCH_INPUT_CLASS =
  'h-8 rounded-md border border-border/25 bg-background/35 pl-8 text-sm text-foreground shadow-xs placeholder:text-muted-foreground/65 backdrop-blur-xs dark:bg-background/25';
