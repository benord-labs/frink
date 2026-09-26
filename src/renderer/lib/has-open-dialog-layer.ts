/**
 * True when a Radix overlay is open that should receive Escape before flow chrome.
 * Covers Dialog/Sheet/Alert (role=dialog), Select listbox, Popover, DropdownMenu.
 */
const OPEN_OVERLAY_SELECTORS = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-popover="true"][data-state="open"]',
  '[data-dropdown="true"][data-state="open"]',
] as const;

export function hasOpenDialogLayer(): boolean {
  return OPEN_OVERLAY_SELECTORS.some((sel) => document.querySelector(sel) !== null);
}
