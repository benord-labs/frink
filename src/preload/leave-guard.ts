import { type IpcRendererEvent, ipcRenderer } from 'electron';
import { LEAVE_CHANNELS, type LeaveReason } from '../shared/leave-reason';

type LeaveIpcRenderer = {
  send: (channel: string, hasUnsaved?: boolean) => void;
  on: (channel: string, listener: (event: IpcRendererEvent, reason: LeaveReason) => void) => void;
  removeListener: (
    channel: string,
    listener: (event: IpcRendererEvent, reason: LeaveReason) => void,
  ) => void;
};

/** Quit, close and Force Reload wait on unsaved editor tabs (see main/windows/leave-guard). */
export function createLeaveGuardApi(ipc: LeaveIpcRenderer) {
  return {
    setHasUnsavedEdits: (hasUnsaved: boolean) => ipc.send(LEAVE_CHANNELS.setUnsaved, hasUnsaved),
    ackLeave: () => ipc.send(LEAVE_CHANNELS.ack),
    confirmLeave: () => ipc.send(LEAVE_CHANNELS.confirm),
    cancelLeave: () => ipc.send(LEAVE_CHANNELS.cancel),
    onLeaveRequested: (callback: (reason: LeaveReason) => void) => {
      const handler = (_event: IpcRendererEvent, reason: LeaveReason) => callback(reason);
      ipc.on(LEAVE_CHANNELS.request, handler);
      return () => ipc.removeListener(LEAVE_CHANNELS.request, handler);
    },
  };
}

export const leaveGuardApi = createLeaveGuardApi(ipcRenderer);

export type LeaveGuardApi = ReturnType<typeof createLeaveGuardApi>;
