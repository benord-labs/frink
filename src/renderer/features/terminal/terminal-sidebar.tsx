import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { AlignJustify } from 'lucide-react';
import { useCallback } from 'react';
import { ResizableSidebar } from '@/components/ui/resizable-sidebar';
import { cn } from '@/lib/utils';
import { InsetGlassSidebarShell } from '../sidebar/inset-glass-sidebar-shell';
import { terminalDisplayModeAtom, terminalSidebarWidthAtom } from './atoms';
import { TerminalContent } from './terminal-content';
import { TerminalPanelHeader } from './terminal-panel-header';
import { TerminalTabs } from './terminal-tabs';
import { useTerminalManager } from './use-terminal-manager';

// Animation constants - keep in sync with ResizableSidebar animationDuration
const SIDEBAR_ANIMATION_DURATION_SECONDS = 0; // Disabled for performance

type TerminalSidebarProps = {
  /** Chat ID - used to scope terminals to this chat */
  chatId: string;
  cwd: string;
  workspaceId: string;
  tabId?: string;
  initialCommands?: string[];
  /** Mobile fullscreen mode - skip ResizableSidebar wrapper */
  isMobileFullscreen?: boolean;
  /** Callback when closing in mobile mode */
  onClose?: () => void;
  /** Split-chat: false when this chat column is inactive. Defaults to true. */
  isPaneActive?: boolean;
};

export function TerminalSidebar({
  chatId,
  cwd,
  workspaceId,
  tabId,
  initialCommands,
  isMobileFullscreen = false,
  onClose,
  isPaneActive = true,
}: TerminalSidebarProps) {
  const displayMode = useAtomValue(terminalDisplayModeAtom);

  const {
    isOpen,
    setIsOpen,
    terminals,
    activeTerminalId,
    activeTerminal,
    terminalCwds,
    terminalBg,
    canRenderTerminal,
    createTerminal,
    selectTerminal,
    closeTerminal,
    closeSplitGroup,
    renameTerminal,
    closeOtherTerminals,
    closeTerminalsToRight,
    closePanel,
    terminalSplitEnabled,
    addSplitPane,
    splitPaneTerminals,
    splitPaneTerminalIds,
    keyboardFocusTerminalId,
    terminalKeyboardTargetId,
    setTerminalKeyboardFocus,
  } = useTerminalManager({ chatId });

  // Handle mobile close - also close the sidebar atom to prevent re-opening as desktop sidebar
  const handleMobileClose = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [setIsOpen, onClose]);

  // When in bottom mode, don't render the sidebar — bottom panel handles it
  if (!isMobileFullscreen && displayMode === 'bottom') {
    return null;
  }

  // Shared terminal content props
  const contentProps = {
    activeTerminal,
    splitPaneTerminals,
    terminalKeyboardTargetId,
    onTerminalPaneFocused: setTerminalKeyboardFocus,
    onCloseSplitPane: closeTerminal,
    canRenderTerminal,
    terminalBg,
    cwd,
    workspaceId,
    tabId,
    initialCommands,
    isPaneActive,
  };

  // Shared header props (used by desktop sidebar; mobile has its own header)
  const headerProps = {
    closePanel,
    terminals,
    activeTerminalId,
    terminalCwds,
    initialCwd: cwd,
    onSelectTerminal: selectTerminal,
    onCloseTerminal: closeTerminal,
    onCloseOtherTerminals: closeOtherTerminals,
    onCloseTerminalsToRight: closeTerminalsToRight,
    onCreateTerminal: createTerminal,
    onRenameTerminal: renameTerminal,
    terminalSplitEnabled,
    onAddSplitPane: addSplitPane,
    splitPaneTerminalIds,
    keyboardFocusTerminalId,
    onCloseSplitGroup: closeSplitGroup,
  };

  // Mobile fullscreen layout — completely different header (no mode switcher, hamburger icon)
  if (isMobileFullscreen) {
    return (
      <div className="relative flex min-h-0 h-full w-full flex-col bg-transparent">
        <div
          className={cn(
            'flex shrink-0 items-center gap-1.5 px-2 py-2',
            'rounded-none border-0 border-b border-border/40 glass-card',
          )}
          style={{
            // @ts-expect-error - WebKit-specific property for Electron window dragging
            // biome-ignore lint/style/useNamingConvention: WebKit CSS property name
            WebkitAppRegion: 'drag',
            borderBottomWidth: '0.5px',
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={handleMobileClose}
            className="h-7 w-7 p-0 touch-target-h7 text-muted-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md hover:text-foreground"
            aria-label="Back to chat"
            style={{
              // @ts-expect-error - WebKit-specific property
              // biome-ignore lint/style/useNamingConvention: WebKit CSS property name
              WebkitAppRegion: 'no-drag',
            }}
            iconOnly
          >
            <AlignJustify className="h-4 w-4" />
          </Button>

          <div className="flex min-w-0 flex-1 items-center gap-1">
            {terminals.length > 0 && (
              <TerminalTabs
                terminals={terminals}
                activeTerminalId={activeTerminalId}
                cwds={terminalCwds}
                initialCwd={cwd}
                onSelectTerminal={selectTerminal}
                onCloseTerminal={closeTerminal}
                onCloseOtherTerminals={closeOtherTerminals}
                onCloseTerminalsToRight={closeTerminalsToRight}
                onCreateTerminal={createTerminal}
                onRenameTerminal={renameTerminal}
                terminalSplitEnabled={terminalSplitEnabled}
                onAddSplitPane={addSplitPane}
                splitPaneTerminalIds={splitPaneTerminalIds}
                keyboardFocusTerminalId={keyboardFocusTerminalId}
                onCloseSplitGroup={closeSplitGroup}
              />
            )}
          </div>
        </div>

        <TerminalContent {...contentProps} />
      </div>
    );
  }

  // Desktop sidebar layout — inset glass shell
  return (
    <ResizableSidebar
      isOpen={isOpen}
      onClose={closePanel}
      widthAtom={terminalSidebarWidthAtom}
      side="right"
      minWidth={350}
      maxWidth={700}
      animationDuration={SIDEBAR_ANIMATION_DURATION_SECONDS}
      initialWidth={0}
      exitWidth={0}
      showResizeTooltip={true}
      className="bg-transparent"
    >
      <InsetGlassSidebarShell edge="right" glassClassName="rounded-xl">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <TerminalPanelHeader orientation="side" {...headerProps} />
          <TerminalContent {...contentProps} />
        </div>
      </InsetGlassSidebarShell>
    </ResizableSidebar>
  );
}
