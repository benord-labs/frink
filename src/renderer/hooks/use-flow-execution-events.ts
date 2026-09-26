/**
 * Global hook that listens for flow execution events from the main process
 * and fires toasts for run_completed, run_failed, and run_cancelled.
 *
 * Mount once at the App level so notifications work from any page.
 */

import { useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { toast } from 'sonner';
import type { FlowExecutionEvent } from '../../shared/types/flow';
import {
  activeOverlayAtom,
  flowsSelectedFlowIdAtom,
  soundNotificationsEnabledAtom,
} from '../lib/atoms';
import { playSound } from '../lib/audio/play-chime';
import { flowEventSound } from '../lib/flow-completion-chime';
import { appStore } from '../lib/jotai-store';
import { isDesktopApp } from '../lib/utils/platform';

/** Programmatically navigate to a flow in the editor (usable outside React). */
export function navigateToFlow(flowId: string): void {
  appStore.set(flowsSelectedFlowIdAtom, flowId);
  appStore.set(activeOverlayAtom, 'flows');
}

export function useFlowExecutionEvents(): void {
  const setSelectedFlowId = useSetAtom(flowsSelectedFlowIdAtom);
  const setOverlay = useSetAtom(activeOverlayAtom);

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.onSocketFlowExecutionEvent) return;

    const unsubscribe = window.desktopApi.onSocketFlowExecutionEvent(
      (event: FlowExecutionEvent) => {
        const { eventType, flowId, flowName, summary } = event;

        // At most one family sound per lifecycle transition (per-node sounds are
        // suppressed via isFlowDriven; batch members are silenced via batchId).
        // Same away-rule as chat completion: silent only when viewing this flow
        // with the window focused.
        const sound = flowEventSound({
          eventType,
          batchId: event.batchId,
          pauseKind: event.pauseKind,
          soundEnabled: appStore.get(soundNotificationsEnabledAtom),
          isViewingThisFlow:
            appStore.get(activeOverlayAtom) === 'flows' &&
            appStore.get(flowsSelectedFlowIdAtom) === flowId,
          isWindowFocused: document.hasFocus(),
        });
        if (sound) void playSound(sound);

        if (eventType === 'run_completed') {
          const description = summary ?? 'Flow run completed.';
          toast.success(flowName, {
            description,
            duration: 5000,
            action: {
              label: 'View',
              onClick: () => {
                setSelectedFlowId(flowId);
                setOverlay('flows');
              },
            },
          });
        } else if (eventType === 'run_failed') {
          const description = summary ?? 'Flow run failed.';
          toast.error(flowName, {
            description,
            duration: 8000,
            action: {
              label: 'View',
              onClick: () => {
                setSelectedFlowId(flowId);
                setOverlay('flows');
              },
            },
          });
        } else if (eventType === 'run_cancelled') {
          toast.info(flowName, {
            description: 'Run was cancelled.',
            duration: 4000,
            action: {
              label: 'View',
              onClick: () => {
                setSelectedFlowId(flowId);
                setOverlay('flows');
              },
            },
          });
        }
      },
    );

    return unsubscribe;
  }, [setSelectedFlowId, setOverlay]);
}
