import { atom, useStore } from 'jotai';
import { useEffect } from 'react';
import { openFilesAtom } from '../state/atoms';
import { requestLeaveAtom } from '../state/close-tabs';

const hasUnsavedTabsAtom = atom((get) => get(openFilesAtom).some((f) => f.isDirty));

/**
 * Lets quit, window close and Force Reload ask about unsaved editor tabs: tells main whether any
 * tab is unsaved, and answers its leave requests through the unsaved-changes prompt.
 */
export function useLeaveGuard(): void {
  const store = useStore();

  useEffect(() => {
    const api = window.desktopApi;
    if (!api) return;
    // Main only waits on the renderer while this says a tab is unsaved, so a clean quit never asks.
    const push = () => api.setHasUnsavedEdits(store.get(hasUnsavedTabsAtom));
    push();
    const unsubscribe = store.sub(hasUnsavedTabsAtom, push);
    const stopListening = api.onLeaveRequested((reason) => {
      api.ackLeave();
      if (!store.set(requestLeaveAtom, reason)) api.confirmLeave();
    });
    return () => {
      unsubscribe();
      stopListening();
    };
  }, [store]);
}
