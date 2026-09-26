/**
 * Pure decision for the permission-prompt alert sound. When the agent raises a permission
 * approval card and the window is unfocused, we play a distinct alert (see playPermissionAlert)
 * so an away user knows the agent has stalled waiting on them. Mirrors the "away" rule of
 * shouldChimeOnFlowTerminal: stay silent while the window is focused (the user can see the card),
 * and only fire for a genuinely new request — never while cycling an existing queue.
 */
export type PermissionAlertArgs = {
  soundEnabled: boolean;
  isWindowFocused: boolean;
  isNew: boolean;
};

export function shouldAlertOnPermissionRequest(args: PermissionAlertArgs): boolean {
  return args.soundEnabled && !args.isWindowFocused && args.isNew;
}
