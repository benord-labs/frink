/**
 * Shared styles for overlay components (Popover, Dropdown, Select, ContextMenu, Command)
 *
 * Design specs:
 * - Container: rounded-[10px], border, shadow, max-height viewport-aware
 * - Items: rounded-md (6px), gap-1.5, padding 5px 6px, margin 4px horizontal
 */

// =============================================================================
// Container Styles (Popover, Dropdown, Select, ContextMenu content)
// =============================================================================

/** The glass material in the popover tone, for every floating overlay (Transparency sets the vars) */
export const overlayGlass =
  'border-border/(--glass-opacity) bg-popover/(--glass-opacity) backdrop-filter-(--glass-filter) glass-lit';

/** Base container styles for all overlay content */
export const overlayContentBase = `z-50 overflow-auto rounded-[10px] border ${overlayGlass} text-sm text-popover-foreground shadow-lg`;

/** Max height to stay within viewport */
export const overlayMaxHeight = 'max-h-[calc(100vh-32px)]';

/** Animation classes for overlay open/close */
export const overlayAnimation =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

/** Slide-in animation based on side */
export const overlaySlideIn =
  'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2';

/** Combined container styles */
export const overlayContent = `${overlayContentBase} ${overlayMaxHeight} ${overlayAnimation} ${overlaySlideIn}`;

// =============================================================================
// Item Styles (DropdownMenuItem, SelectItem, CommandItem, ContextMenuItem)
// =============================================================================

/** Base item layout - margin creates spacing from container edges */
export const overlayItemBase =
  'flex items-center gap-1.5 min-h-[32px] py-[5px] px-1.5 mx-1 rounded-md text-sm cursor-default select-none outline-hidden';

/** Item hover state */
export const overlayItemHover = 'hover:bg-accent dark:hover:bg-secondary hover:text-foreground';

/** Item focus state (keyboard navigation) */
export const overlayItemFocus =
  'focus:bg-accent dark:focus:bg-secondary focus:text-accent-foreground';

/** Radix data-highlighted state (used by DropdownMenu, Select, ContextMenu) */
const overlayItemHighlighted =
  'data-highlighted:bg-accent dark:data-highlighted:bg-secondary data-highlighted:text-accent-foreground';

/** Item disabled state */
export const overlayItemDisabled = 'data-disabled:pointer-events-none data-disabled:opacity-50';

/** Item transition */
export const overlayItemTransition = 'transition-colors';

/** Combined item styles */
export const overlayItem = `${overlayItemBase} ${overlayItemHover} ${overlayItemFocus} ${overlayItemHighlighted} ${overlayItemDisabled} ${overlayItemTransition}`;

/** Item with icon styles (includes svg handling) */
export const overlayItemWithIcon = `${overlayItem} [&_svg]:pointer-events-none [&_svg]:shrink-0`;

// =============================================================================
// Checkbox/Radio Item Styles
// =============================================================================

/** Indicator container (positioned left) */
export const overlayItemIndicator = 'absolute left-2 flex h-3.5 w-3.5 items-center justify-center';

// =============================================================================
// Supporting Elements
// =============================================================================

/** Separator styles - full width with vertical margin */
export const overlaySeparator = 'my-1 h-px bg-border mx-1';

/** Label styles */
export const overlayLabel = 'px-2.5 py-1.5 mx-1 text-xs font-medium text-muted-foreground';
