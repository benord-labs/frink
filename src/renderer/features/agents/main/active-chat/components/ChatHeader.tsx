import { Button } from '@benord-labs/frink-primitives';
import { ListTodo, PanelRight, Undo2 } from 'lucide-react';
import { memo } from 'react';
import { Kbd } from '../../../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { cn } from '../../../../../lib/utils';
import { isMacOS } from '../../../../../lib/utils/platform';
import { PaneUtilityButtons } from '../../../components/pane-utility-buttons';
import { PreviewSetupHoverCard } from '../../../components/preview-setup-hover-card';
import { useFileTreeToggle } from '../../../hooks/use-file-tree-toggle';
import { AccountIndicator } from '../../../ui/account-indicator';
import { AgentsHeaderControls } from '../../../ui/agents-header-controls';
import { HeaderBadge } from '../../../ui/header-badge';
import { MobileChatHeader } from '../../../ui/mobile-chat-header';

type DiffStatsType = {
  fileCount: number;
  additions: number;
  deletions: number;
  isLoading: boolean;
  hasChanges: boolean;
};

type ChatHeaderProps = {
  // Layout state
  isMobileFullscreen: boolean;

  // Sidebar states
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** When in split view, the 0-based pane index. undefined = not in split view. */
  splitPaneIndex?: number;
  hasAnyUnseenChanges: boolean;
  isPreviewSidebarOpen: boolean;
  setIsPreviewSidebarOpen: (open: boolean) => void;
  isTerminalSidebarOpen: boolean;
  setIsTerminalSidebarOpen: (open: boolean) => void;
  setIsDiffSidebarOpen: (open: boolean) => void;

  // Chat info
  chatId: string;
  gitContextPath: string | null;
  sandboxId: string | null;
  canOpenPreview: boolean;
  canOpenDiff: boolean;
  diffStats: DiffStatsType;
  isArchived: boolean;
  taskId: string | null; // Link to work queue task (null for regular chats)

  // Callbacks
  onBackToChats: () => void;
  onOpenPreview: () => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  handleRestoreWorkspace: () => void;
  restoreWorkspaceMutationIsPending: boolean;
};

export const ChatHeader = memo(function ChatHeader({
  isMobileFullscreen,
  isSidebarOpen,
  onToggleSidebar,
  splitPaneIndex,
  hasAnyUnseenChanges,
  isPreviewSidebarOpen,
  setIsPreviewSidebarOpen,
  isTerminalSidebarOpen,
  setIsTerminalSidebarOpen,
  setIsDiffSidebarOpen,
  chatId,
  gitContextPath,
  sandboxId,
  canOpenPreview,
  canOpenDiff,
  diffStats,
  isArchived,
  taskId,
  onBackToChats,
  onOpenPreview,
  onOpenDiff,
  onOpenTerminal,
  handleRestoreWorkspace,
  restoreWorkspaceMutationIsPending,
}: ChatHeaderProps) {
  const isInSplitView = splitPaneIndex !== undefined;
  const canOpenTerminal = !!gitContextPath;
  const hasProject = !!gitContextPath;
  const { fileTreeOpen, modifiedFiles, toggleFileTree } = useFileTreeToggle({
    splitPaneIndex,
    projectPath: gitContextPath ?? undefined,
  });

  return (
    <div
      className={cn(
        'relative z-20 pointer-events-none shrink-0 p-2 pt-1.5 @container/pane-header',
        // Single-pane content starts beneath the macOS traffic lights. Split panes already have a
        // PaneHeader above this row, so only the top-level header needs vertical clearance.
        isMacOS() && !isSidebarOpen && splitPaneIndex === undefined && 'pt-7',
      )}
    >
      {/* Keep this row statically positioned: the relative outer header owns the split-pane
          sidebar button, so a pane file tree shifts that containing block instead of being covered. */}
      <div className="pointer-events-auto flex items-center justify-between gap-2 overflow-hidden">
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
          {/* Mobile header - simplified with chat name as trigger */}
          {isMobileFullscreen ? (
            <MobileChatHeader
              onBackToChats={onBackToChats}
              onOpenPreview={onOpenPreview}
              canOpenPreview={canOpenPreview}
              onOpenDiff={onOpenDiff}
              canOpenDiff={canOpenDiff}
              diffStats={diffStats}
              onOpenTerminal={onOpenTerminal}
              canOpenTerminal={!!gitContextPath}
              isArchived={isArchived}
              onRestore={handleRestoreWorkspace}
            />
          ) : (
            <>
              {/* Header controls - desktop only (open sidebar toggle) */}
              <AgentsHeaderControls
                isSidebarOpen={isSidebarOpen}
                onToggleSidebar={onToggleSidebar}
                splitPaneIndex={splitPaneIndex}
                hasUnseenChanges={hasAnyUnseenChanges}
              />
              {/* Account badge - which Claude account is used */}
              <AccountIndicator chatId={chatId} />
              {/* Styled like the icon buttons beside it; its word goes with the account's provider. */}
              {taskId && (
                <HeaderBadge
                  title="Work Queue task"
                  className="h-6 gap-1.5 rounded-md bg-transparent px-1.5 text-foreground shrink-0 @max-[26rem]/pane-header:w-6 @max-[26rem]/pane-header:justify-center @max-[26rem]/pane-header:px-0"
                >
                  <ListTodo
                    className="h-3 w-3 shrink-0 @max-[26rem]/pane-header:h-4 @max-[26rem]/pane-header:w-4"
                    aria-hidden
                  />
                  <span className="@max-[26rem]/pane-header:sr-only">Task</span>
                </HeaderBadge>
              )}

              {/* Empty header space doubles as the frameless window's drag handle. */}
              <div className="drag-region h-7 flex-1 min-w-0" />
            </>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Pane utilities: fixed column so they stay visible in narrow multi-pane. */}
          {!isMobileFullscreen && (
            <PaneUtilityButtons
              showFileTree={isInSplitView && hasProject}
              fileTreeOpen={fileTreeOpen}
              hasModifiedFiles={modifiedFiles}
              onToggleFileTree={toggleFileTree}
              showDiff={canOpenDiff}
              diffStats={diffStats}
              onOpenDiff={() => setIsDiffSidebarOpen(true)}
              showTerminal={canOpenTerminal}
              terminalOpen={isTerminalSidebarOpen}
              onToggleTerminal={() => setIsTerminalSidebarOpen(!isTerminalSidebarOpen)}
            />
          )}
          {/* Open Preview Button - shows when preview is closed (desktop only) */}
          {!isMobileFullscreen &&
            !isPreviewSidebarOpen &&
            sandboxId &&
            (canOpenPreview ? (
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsPreviewSidebarOpen(true)}
                    className="h-6 w-6 p-0 text-foreground shrink-0 rounded-md"
                    aria-label="Open preview"
                    iconOnly
                  >
                    <PanelRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open preview</TooltipContent>
              </Tooltip>
            ) : (
              <PreviewSetupHoverCard>
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    className="h-6 w-6 p-0 text-muted-foreground shrink-0 rounded-md cursor-not-allowed pointer-events-none"
                    aria-label="Preview not available"
                    iconOnly
                  >
                    <PanelRight className="h-4 w-4" />
                  </Button>
                </span>
              </PreviewSetupHoverCard>
            ))}
          {/* Restore Button - shows when viewing archived workspace (desktop only) */}
          {!isMobileFullscreen && isArchived && (
            <Tooltip delayDuration={500}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  onClick={handleRestoreWorkspace}
                  disabled={restoreWorkspaceMutationIsPending}
                  className="h-6 px-2 gap-1.5 text-foreground shrink-0 rounded-md ml-2 flex"
                  aria-label="Restore workspace"
                >
                  <Undo2 className="h-4 w-4" />
                  <span className="text-xs">Restore</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Restore workspace
                <Kbd shortcutId="collapse-all-sidebar" />
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
});
