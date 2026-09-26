import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { AlignJustify } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { newChatTerminalId } from '@/lib/agent-chat/sentinel-ids';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/lib/utils/platform';
import { terminalSidebarOpenAtomFamily } from '../../terminal/atoms';
import { useFileTreeToggle } from '../hooks/use-file-tree-toggle';
import { STRINGS } from '../main/new-chat-form-constants';
import { AccountIndicator } from '../ui/account-indicator';
import { AgentsHeaderControls } from '../ui/agents-header-controls';
import { PaneUtilityButtons } from './pane-utility-buttons';

type NewChatFormHeaderProps = {
  isMobileFullscreen: boolean;
  isSidebarOpen: boolean;
  hasUnseenChanges: boolean;
  onToggleSidebar: () => void;
  onBackToChats?: () => void;
  /** Selected project ID — used to show which account will be used for the new chat. */
  projectId?: string;
  /** When in split view, the 0-based pane index. Enables file tree toggle. */
  splitPaneIndex?: number;
  /** Local project path — enables terminal + file tree buttons. */
  projectPath?: string;
};

/**
 * Header for NewChatForm
 * Shows burger menu on mobile, full controls + account badge + utility buttons on desktop
 */
export const NewChatFormHeader = memo(function NewChatFormHeader({
  isMobileFullscreen,
  isSidebarOpen,
  hasUnseenChanges,
  onToggleSidebar,
  onBackToChats,
  projectId,
  splitPaneIndex,
  projectPath,
}: NewChatFormHeaderProps) {
  // File tree toggle — shared hook with ChatHeader
  const { isInSplitView, hasProject, fileTreeOpen, modifiedFiles, toggleFileTree } =
    useFileTreeToggle({ splitPaneIndex, projectPath });

  // Terminal sidebar state — uses per-pane sentinel key, paired with TerminalBottomPanel in new-chat-form
  const terminalId = useMemo(() => newChatTerminalId(splitPaneIndex), [splitPaneIndex]);
  const terminalSidebarAtom = useMemo(
    () => terminalSidebarOpenAtomFamily(terminalId),
    [terminalId],
  );
  const [isTerminalOpen, setIsTerminalSidebarOpen] = useAtom(terminalSidebarAtom);
  const toggleTerminal = useCallback(
    () => setIsTerminalSidebarOpen(!isTerminalOpen),
    [setIsTerminalSidebarOpen, isTerminalOpen],
  );

  return (
    <div
      className={cn(
        'relative shrink-0 flex items-center justify-between p-1.5 @container/pane-header [--open-sidebar-slot-start:0.375rem]',
        isMacOS() &&
          !isMobileFullscreen &&
          !isSidebarOpen &&
          splitPaneIndex === undefined &&
          'pt-7',
      )}
    >
      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-clip -mx-1 px-1">
        {isMobileFullscreen ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onBackToChats}
            className="h-7 w-7 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md"
            aria-label={STRINGS.BUTTON_ALL_PROJECTS}
            iconOnly
          >
            <AlignJustify className="h-4 w-4" />
          </Button>
        ) : (
          <>
            <AgentsHeaderControls
              isSidebarOpen={isSidebarOpen}
              onToggleSidebar={onToggleSidebar}
              splitPaneIndex={splitPaneIndex}
              hasUnseenChanges={hasUnseenChanges}
            />
            <AccountIndicator projectId={projectId} />

            {/* Spacer to push utility buttons to the right */}
            <div className="flex-1" />

            <PaneUtilityButtons
              showFileTree={isInSplitView && hasProject}
              fileTreeOpen={fileTreeOpen}
              hasModifiedFiles={modifiedFiles}
              onToggleFileTree={toggleFileTree}
              showTerminal={hasProject}
              terminalOpen={isTerminalOpen}
              onToggleTerminal={toggleTerminal}
            />
          </>
        )}
      </div>
    </div>
  );
});
