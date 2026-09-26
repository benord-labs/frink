import { OpenSidebarButton } from '../../../components/ui/open-sidebar-button';

type AgentsHeaderControlsProps = {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** When in split view, the 0-based pane index. undefined = not in split view. */
  splitPaneIndex?: number;
  hasUnseenChanges?: boolean;
};

export function AgentsHeaderControls({
  isSidebarOpen,
  onToggleSidebar,
  splitPaneIndex,
  hasUnseenChanges = false,
}: AgentsHeaderControlsProps) {
  // Only show on pane 0 (or when not in split view)
  if (splitPaneIndex !== undefined && splitPaneIndex > 0) return null;

  return (
    <OpenSidebarButton
      isSidebarOpen={isSidebarOpen}
      onOpenSidebar={onToggleSidebar}
      hasUnseenChanges={hasUnseenChanges}
    />
  );
}
