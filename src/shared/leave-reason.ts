/** Why the main window is about to go away; the renderer asks about unsaved editor tabs first. */
export type LeaveReason = 'close' | 'quit' | 'reload' | 'update';

/** IPC between main's leave guard and the renderer; both sides read these names. */
export const LEAVE_CHANNELS = {
  setUnsaved: 'leave-guard:set-unsaved',
  request: 'leave-guard:request',
  ack: 'leave-guard:ack',
  confirm: 'leave-guard:confirm',
  cancel: 'leave-guard:cancel',
} as const;
