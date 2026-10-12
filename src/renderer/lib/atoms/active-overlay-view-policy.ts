export type LayoutDestination = 'chat' | 'workqueue' | 'settings' | 'flows';

export type OverlayDestination = Exclude<LayoutDestination, 'chat'>;

export type ActiveOverlayViewPolicy = {
  isMainPaneInset: boolean;
  /** Whether this destination can show the unified sidebar at all, regardless of open state. */
  canToggleUnifiedSidebar: boolean;
  isUnifiedSidebarOpen: boolean;
  showFilesSidebar: boolean;
  showFileSearch: boolean;
  /** Chat-pane shortcuts that act on the focused chat belong to the visible desktop chat only. */
  canArchiveFocusedChat: boolean;
};

type ActiveOverlayViewPolicyOptions = {
  destination: LayoutDestination;
  isMobile: boolean;
  isSplitActive: boolean;
  sidebarOpen: boolean;
  /** Single-pane Files sidebar; it can be open while the unified sidebar is closed. */
  filesSidebarOpen: boolean;
  /**
   * Flows is not an atomic destination: its dashboard behaves like Work Queue, while the flow
   * editor is a full-width takeover. Ignored for every other destination.
   */
  isFlowEditorOpen: boolean;
};

/** Resolve the default chat destination without coupling layout policy to the overlay atom. */
export function resolveLayoutDestination(
  activeOverlay: OverlayDestination | null,
): LayoutDestination {
  return activeOverlay ?? 'chat';
}

/** Named visibility and framing rules for each top-level Agents destination. */
export function getActiveOverlayViewPolicy({
  destination,
  isMobile,
  isSplitActive,
  sidebarOpen,
  filesSidebarOpen,
  isFlowEditorOpen,
}: ActiveOverlayViewPolicyOptions): ActiveOverlayViewPolicy {
  const isChat = destination === 'chat';
  const isFlowsDashboard = destination === 'flows' && !isFlowEditorOpen;
  const supportsUnifiedSidebar = isChat || destination === 'workqueue' || isFlowsDashboard;
  const canToggleUnifiedSidebar = supportsUnifiedSidebar && !isMobile;
  const isUnifiedSidebarOpen = canToggleUnifiedSidebar && sidebarOpen;
  const showFilesSidebar = isChat && !isSplitActive;

  return {
    // The main pane is inset only from a sidebar that is actually visible. A closed sidebar keeps
    // zero width in the row, so keeping the seam would leave a dead strip on the window edge.
    isMainPaneInset: isUnifiedSidebarOpen || (showFilesSidebar && filesSidebarOpen),
    canToggleUnifiedSidebar,
    isUnifiedSidebarOpen,
    showFilesSidebar,
    showFileSearch: isChat,
    canArchiveFocusedChat: isChat && !isMobile,
  };
}
