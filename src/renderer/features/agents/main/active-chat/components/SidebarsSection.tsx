import { useAtomValue } from 'jotai';
import { memo, type ReactElement, type ReactNode } from 'react';
import { SidePanelDockPortal } from '../../../../../components/SidePanelDock';
import { ResizableSidebar } from '../../../../../components/ui/resizable-sidebar';
import { TerminalSidebar } from '../../../../../features/terminal/terminal-sidebar';
import {
  agentsDiffSidebarWidthAtom,
  agentsPreviewSidebarWidthAtom,
  splitViewChatIdsAtom,
} from '../../../atoms';
import { AgentPreview } from '../../../ui/agent-preview';
import { EmptyPreviewState } from './EmptyPreviewState';

// Style objects - hoisted to module level for performance
const BORDER_LEFT_WIDTH_STYLE = { borderLeftWidth: '0.5px' } as const;

type Props = {
  /** Whether this pane is the active one */
  isActive?: boolean;
  // Mobile & display
  isMobileFullscreen: boolean;

  // Diff panel
  canOpenDiff: boolean;
  isDiffSidebarOpen: boolean;
  setIsDiffSidebarOpen: (open: boolean) => void;
  /** The chat's diff panel; null when the chat has no worktree to diff */
  diffPanel: ReactNode;
  gitContextPath: string | null;
  chatId: string;
  sandboxId: string | null;
  repository: { owner: string; name: string } | null;

  // Preview Sidebar
  canOpenPreview: boolean;
  isPreviewSidebarOpen: boolean;
  setIsPreviewSidebarOpen: (open: boolean) => void;
  isQuickSetup: boolean;
  previewPort: number | null;
};

/**
 * SidebarsSection - All right-side sidebars (Diff, Preview, Terminal)
 * Extracted to reduce complexity in ChatView. Wrapped in memo to avoid re-renders when parent re-renders.
 */
export const SidebarsSection = memo(function SidebarsSection({
  isActive,
  isMobileFullscreen,
  canOpenDiff,
  isDiffSidebarOpen,
  setIsDiffSidebarOpen,
  diffPanel,
  gitContextPath,
  chatId,
  sandboxId,
  repository,
  canOpenPreview,
  isPreviewSidebarOpen,
  setIsPreviewSidebarOpen,
  isQuickSetup,
  previewPort,
}: Props): ReactElement {
  // A single chat docks its panels right of the main pane. Only split view (2+ chats) mounts
  // SplitPane's @container/pane, so its panels stay inside and keep the pane size classes
  const isSplitView = useAtomValue(splitViewChatIdsAtom).length >= 2;
  return (
    <SidePanelDockPortal docked={!isSplitView && !isMobileFullscreen}>
      {canOpenDiff && diffPanel && !isMobileFullscreen && (
        <ResizableSidebar
          isOpen={isDiffSidebarOpen}
          onClose={() => setIsDiffSidebarOpen(false)}
          widthAtom={agentsDiffSidebarWidthAtom}
          minWidth={320}
          side="right"
          animationDuration={0}
          initialWidth={0}
          exitWidth={0}
          showResizeTooltip={true}
          className="bg-transparent"
        >
          {diffPanel}
        </ResizableSidebar>
      )}

      {/* Preview Sidebar - hidden on mobile fullscreen and when preview is not available */}
      {canOpenPreview && !isMobileFullscreen && sandboxId && typeof previewPort === 'number' && (
        <ResizableSidebar
          isOpen={isPreviewSidebarOpen}
          onClose={() => setIsPreviewSidebarOpen(false)}
          widthAtom={agentsPreviewSidebarWidthAtom}
          minWidth={350}
          side="right"
          animationDuration={0}
          initialWidth={0}
          exitWidth={0}
          showResizeTooltip={true}
          className="bg-tl-background border-l"
          style={BORDER_LEFT_WIDTH_STYLE}
        >
          {isQuickSetup ? (
            <EmptyPreviewState onClose={() => setIsPreviewSidebarOpen(false)} />
          ) : (
            <AgentPreview
              chatId={chatId}
              sandboxId={sandboxId}
              port={previewPort}
              repository={repository ? `${repository.owner}/${repository.name}` : undefined}
              hideHeader={false}
              onClose={() => setIsPreviewSidebarOpen(false)}
            />
          )}
        </ResizableSidebar>
      )}

      {/* Terminal Sidebar - shows when worktree exists (desktop only) */}
      {gitContextPath && (
        <TerminalSidebar
          chatId={chatId}
          cwd={gitContextPath}
          workspaceId={chatId}
          isPaneActive={isActive}
        />
      )}
    </SidePanelDockPortal>
  );
});
