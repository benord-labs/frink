/**
 * Layout tokens for the expression-mode toggle button in FlowBranchField.
 * Matches the height and radius of SelectTrigger used in the same form.
 */

/**
 * Expression / list toggle — LAYOUT ONLY (height h-9 + radius rounded-[10px] to match the
 * SelectTrigger in the same form). Colour/border/hover/focus/disabled are owned by the
 * Button's variant="secondary" — don't re-add them here or they fight the theme.
 */
export const FLOW_BRANCH_ICON_BUTTON = 'h-9 w-9 shrink-0 rounded-[10px] [&_svg]:size-4';
