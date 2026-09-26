export const DEFAULT_MIN_WIDTH = 200;
export const DEFAULT_MAX_WIDTH = 9999;
export const DEFAULT_ANIMATION_DURATION = 0;
export const EXTENDED_HOVER_AREA_WIDTH = 8;
export const TOOLTIP_DELAY_MS = 300;
export const TOOLTIP_FADE_DURATION = 0.05;
export const MOVE_THRESHOLD_PX = 3;
export const RESIZE_HANDLE_WIDTH_PX = 4;
export const RESIZE_HANDLE_OFFSET_PX = -2;
export const RESIZE_HANDLE_PADDING_PX = 2;
export const TOOLTIP_OFFSET_PX = 8;

/** Split-pane size classes (docs/decisions/split-pane-size-classes.md): a panel docks while the
 *  pane fits its minimum + a 12.5rem chat floor, else fills it. Inert outside `@container/pane`. */
export const PANE_NARROW_PANEL_MAX_MIN_WIDTH = 160;
// 22.5rem = a 160px panel (the file tree) + the floor.
export const PANE_NARROW_PANEL_CLASS = [
  '@min-[22.5rem]/pane:max-w-[calc(100%-12.5rem)]',
  '@max-[22.5rem]/pane:absolute @max-[22.5rem]/pane:inset-0 @max-[22.5rem]/pane:z-10',
  '@max-[22.5rem]/pane:w-full! @max-[22.5rem]/pane:min-w-0! @max-[22.5rem]/pane:visible',
  '@max-[22.5rem]/pane:[&>[data-resize-chrome]]:hidden',
].join(' ');
// 34.5rem = the 320-350px panels (Terminal, Details, Diff, Preview) + the floor.
export const PANE_WIDE_PANEL_CLASS = [
  '@min-[34.5rem]/pane:max-w-[calc(100%-12.5rem)]',
  '@max-[34.5rem]/pane:absolute @max-[34.5rem]/pane:inset-0 @max-[34.5rem]/pane:z-10',
  '@max-[34.5rem]/pane:w-full! @max-[34.5rem]/pane:min-w-0! @max-[34.5rem]/pane:visible',
  '@max-[34.5rem]/pane:[&>[data-resize-chrome]]:hidden',
].join(' ');
/** The chat column while a Compact panel fills its pane: hidden (so unfocusable) but still running. */
export const PANE_CHAT_BEHIND_PANEL_CLASS = [
  '@max-[22.5rem]/pane:group-has-[[data-pane-panel]]/pane-body:invisible',
  '@max-[34.5rem]/pane:group-has-[[data-pane-panel=wide]]/pane-body:invisible',
].join(' ');

export const UI_TEXT = {
  CLOSE: 'Close',
  RESIZE: 'Resize',
  CLICK: 'Click',
  DRAG: 'Drag',
  OR: 'or',
  RESIZE_ARIA_LABEL: 'Resize sidebar',
} as const;
