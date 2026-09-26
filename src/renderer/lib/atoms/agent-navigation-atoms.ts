import { atom } from 'jotai';
import { atomWithWindowStorage } from '../window-storage';

// Selected agent chat ID - null means "new chat" view (persisted to restore on reload).
export const selectedAgentChatIdAtom = atomWithWindowStorage<string | null>(
  'agents:selectedChatId',
  null,
  { getOnInit: true },
);

/** Mutually exclusive full-page destinations layered over the chat surface. */
export type ActiveOverlay = 'flows' | 'settings' | 'workqueue' | null;
export const activeOverlayAtom = atom<ActiveOverlay>(null);

/**
 * The destination Settings temporarily replaced, restored when it closes. Typed rather than a
 * Work-Queue boolean because every destination that can reach the sidebar's Settings entry point
 * needs its own return path.
 */
const settingsReturnDestinationAtom = atom<ActiveOverlay>(null);

/** Destinations Settings stands in for; anything else closes to chat. */
function settingsReturnFor(activeOverlay: ActiveOverlay): ActiveOverlay {
  return activeOverlay === 'workqueue' || activeOverlay === 'flows' ? activeOverlay : null;
}

/** Back-compat settings facade that restores the destination it temporarily replaced. */
export const agentsSettingsDialogOpenAtom = atom(
  (get) => get(activeOverlayAtom) === 'settings',
  (get, set, value: boolean) => {
    if (value) {
      const activeOverlay = get(activeOverlayAtom);
      if (activeOverlay === 'settings') return;
      set(settingsReturnDestinationAtom, settingsReturnFor(activeOverlay));
      set(activeOverlayAtom, 'settings');
    } else {
      if (get(activeOverlayAtom) === 'settings') {
        set(activeOverlayAtom, get(settingsReturnDestinationAtom));
      }
      set(settingsReturnDestinationAtom, null);
    }
  },
);

export const flowsSelectedFlowIdAtom = atom<string | null>(null);

/**
 * Flows is not an atomic destination. FlowsPage branches on the selection's truthiness, and both
 * the layout view policy and the sidebar need the same answer to frame it — so derive it once here
 * rather than repeating the comparison (with opposite polarity) at each consumer.
 */
export const flowsDashboardActiveAtom = atom(
  (get) => get(activeOverlayAtom) === 'flows' && !get(flowsSelectedFlowIdAtom),
);

/** The full-width flow editor holds the pane, so no sidebar and no destination dismissal. */
export const flowEditorOpenAtom = atom(
  (get) => get(activeOverlayAtom) === 'flows' && Boolean(get(flowsSelectedFlowIdAtom)),
);
export const flowEditorDirtyAtom = atom(false);

/**
 * Which transient destinations a caller may dismiss on the user's behalf. Work Queue is always
 * dismissable; the Flows dashboard is opt-in because the shared hotkey pre-action path
 * (EXIT_HOTKEY_ACTIONS) runs this for pane and search shortcuts that must act in place on Flows
 * rather than ejecting the user out of it. Only surfaces actually rendered beside Flows — the
 * unified sidebar — should opt in.
 */
type NavigationExitScope = { flows?: boolean };

/**
 * Exit a transient destination, including when Settings temporarily replaced it, before a
 * navigation action. Returns whether a destination was actually dismissed.
 */
export const exitTransientDestinationForNavigationAtom = atom(
  null,
  (get, set, scope?: NavigationExitScope): boolean => {
    const activeOverlay = get(activeOverlayAtom);
    // Settings stands in for whatever it replaced, so authority is decided against that origin.
    const effective =
      activeOverlay === 'settings' ? get(settingsReturnDestinationAtom) : activeOverlay;

    const canDismiss =
      effective === 'workqueue' ||
      // Never the flow editor: it is a full-width takeover with unsaved-draft state of its own.
      (effective === 'flows' && scope?.flows === true && !get(flowsSelectedFlowIdAtom));
    if (!canDismiss) return false;

    set(settingsReturnDestinationAtom, null);
    set(activeOverlayAtom, null);
    return true;
  },
);

/**
 * The unified sidebar's exit. It is the one surface rendered beside the Flows dashboard, so it is
 * the one caller allowed to dismiss it — the shared hotkey pre-action path must not.
 */
export const exitDestinationForSidebarNavigationAtom = atom(null, (_get, set): boolean =>
  set(exitTransientDestinationForNavigationAtom, { flows: true }),
);

/**
 * Leave the overlay stack for the chat surface — unless a flow editor sits beneath (it has
 * unsaved-draft state of its own and is never dismissed on a caller's behalf), then the whole
 * stack survives, Settings return target included, so nothing is discarded. Settings stands in
 * for whatever it replaced, so authority belongs to that origin — the editor can be two levels
 * down. Returns whether the stack was left.
 */
export const leaveOverlayStackForChatSurfaceAtom = atom(null, (get, set): boolean => {
  const activeOverlay = get(activeOverlayAtom);
  const effective =
    activeOverlay === 'settings' ? get(settingsReturnDestinationAtom) : activeOverlay;
  if (effective === 'flows' && get(flowsSelectedFlowIdAtom)) return false;
  set(settingsReturnDestinationAtom, null);
  set(activeOverlayAtom, null);
  return true;
});

/**
 * Focus a user-requested chat without dismissing the Flows editor. Every other destination is a
 * transient stand-in for chat, so explicit chat focus exits it and consumes any Settings return
 * target — otherwise writers outside the sidebar (task notifications, agent chat-moves) would
 * select a chat that stays hidden behind the visible destination.
 */
export const focusAgentChatAtom = atom(null, (_get, set, chatId: string) => {
  set(leaveOverlayStackForChatSurfaceAtom);
  set(selectedAgentChatIdAtom, chatId);
});

/**
 * Write-only action atom: close the flows overlay and navigate to a specific agent chat.
 * The caller must check `flowEditorDirtyAtom` first and show a confirmation dialog if dirty.
 * This atom performs the navigation unconditionally (use for confirmed navigation).
 */
export const navigateToAgentChatAtom = atom(null, (_get, set, chatId: string) => {
  set(flowEditorDirtyAtom, false);
  set(activeOverlayAtom, null);
  set(selectedAgentChatIdAtom, chatId);
});
