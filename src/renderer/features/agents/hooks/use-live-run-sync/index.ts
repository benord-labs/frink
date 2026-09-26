import { useEffect, useRef } from 'react';
import { appStore } from '../../../../lib/jotai-store';
import {
  hasActiveTransport,
  observedRunAtomFamily,
  runLiveAtomFamily,
  runSettlingAtomFamily,
} from '../../../../lib/stores/active-transport-registry';
import { type LiveRunSocketClient, startLiveRunSync } from '../../../../lib/stores/live-run-sync';
import {
  beginLiveRunHydration,
  completeLiveRunHydration,
} from '../../../../lib/stores/renderer-recovery-ready';
import { trpcClient } from '../../../../lib/trpc';
import { isDesktopApp } from '../../../../lib/utils/platform';
import { applyAskUserQuestionChunk } from '../../lib/ask-user-question-chunks';
import { useStreamingStatusStore } from '../../stores/streaming-status-store';

function publishLiveRunState(subChatId: string, live: boolean, settling: boolean): void {
  appStore.set(runLiveAtomFamily(subChatId), live);
  appStore.set(runSettlingAtomFamily(subChatId), settling);
  // A transport this window owns is the status owner for its own turn; only observed runs
  // (no local transport) take their presentation status from this lane.
  if (hasActiveTransport(subChatId)) {
    appStore.set(observedRunAtomFamily(subChatId), false);
    return;
  }
  appStore.set(observedRunAtomFamily(subChatId), live);
  useStreamingStatusStore.getState().setStatus(subChatId, live ? 'streaming' : 'ready');
}

/** App-level liveness projection for main-owned executions, including unmounted sub-chats. */
export function useLiveRunSync(): void {
  const beganHydrationRef = useRef(false);
  if (!beganHydrationRef.current && isDesktopApp()) {
    beganHydrationRef.current = true;
    beginLiveRunHydration();
  }

  useEffect(() => {
    if (!isDesktopApp() || !window.desktopApi) {
      completeLiveRunHydration();
      return;
    }
    return startLiveRunSync({
      desktopApi: window.desktopApi,
      socket: trpcClient.socket as unknown as LiveRunSocketClient | undefined,
      publish: publishLiveRunState,
      applyQuestionChunk: (input) =>
        applyAskUserQuestionChunk(input as Parameters<typeof applyAskUserQuestionChunk>[0]),
      completeHydration: completeLiveRunHydration,
    });
  }, []);
}
