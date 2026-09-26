import { appStore } from '../../jotai-store';
import { runLiveAtomFamily, runSettlingAtomFamily } from '../../stores/active-transport-registry';
import { isLiveRunHydrationComplete } from '../../stores/renderer-recovery-ready';

/** Whether a send must steer or queue instead of going direct: a direct send on a run main still
 * owns aborts it, and the renderer's status alone can read idle then (remount, hot update, boot). */
export function isRunBusy(subChatId: string, rendererStreaming: boolean): boolean {
  return (
    rendererStreaming || !isLiveRunHydrationComplete() || appStore.get(runLiveAtomFamily(subChatId))
  );
}

/** Main is only finalizing the sub-chat's completed turn: nothing is left to steer, and a queued
 * send can go the moment main settles it. */
export function isRunSettling(subChatId: string): boolean {
  return isLiveRunHydrationComplete() && appStore.get(runSettlingAtomFamily(subChatId));
}
