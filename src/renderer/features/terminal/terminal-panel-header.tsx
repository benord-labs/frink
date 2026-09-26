import { Button } from '@benord-labs/frink-primitives';
import { memo } from 'react';
import { ChevronsRight } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { TerminalModeSwitcher } from './terminal-mode-switcher';
import { TerminalTabs } from './terminal-tabs';
import type { TerminalInstance } from './types';

type TerminalPanelHeaderProps = {
  /** 'side' for right sidebar, 'bottom' for bottom panel */
  orientation: 'side' | 'bottom';
  closePanel: () => void;
  terminals: TerminalInstance[];
  activeTerminalId: string | null;
  terminalCwds: Record<string, string>;
  initialCwd: string;
  onSelectTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
  onCloseOtherTerminals: (id: string) => void;
  onCloseTerminalsToRight: (id: string) => void;
  onCreateTerminal: () => void;
  onRenameTerminal: (id: string, name: string) => void;
  /** Hide the mode switcher (e.g. new-chat has no sidebar counterpart) */
  hideModeSwitcher?: boolean;
  /** Multi-pane strip — tab split indicators when true. */
  terminalSplitEnabled?: boolean;
  onAddSplitPane?: () => void;
  /** Session ids in the horizontal strip (tab chrome). */
  splitPaneTerminalIds?: readonly string[];
  keyboardFocusTerminalId?: string | null;
  onCloseSplitGroup?: () => void;
};

/**
 * Shared header for terminal sidebar and bottom panel.
 * Renders close button + mode switcher + tabs. Orientation controls:
 * - icon rotation (bottom: 90deg, side: 0)
 * - tooltip side (bottom: top, side: bottom)
 * - padding (bottom: py-1, side: py-1.5)
 */
export const TerminalPanelHeader = memo(function TerminalPanelHeader({
  orientation,
  closePanel,
  terminals,
  activeTerminalId,
  terminalCwds,
  initialCwd,
  onSelectTerminal,
  onCloseTerminal,
  onCloseOtherTerminals,
  onCloseTerminalsToRight,
  onCreateTerminal,
  onRenameTerminal,
  hideModeSwitcher = false,
  terminalSplitEnabled = false,
  onAddSplitPane,
  splitPaneTerminalIds = [],
  keyboardFocusTerminalId = null,
  onCloseSplitGroup,
}: TerminalPanelHeaderProps) {
  const isBottom = orientation === 'bottom';
  const tooltipSide = isBottom ? 'top' : 'bottom';

  return (
    <div
      className={cn(
        'flex shrink-0 items-center [box-shadow:none]',
        isBottom
          ? // Bottom dock: the dock's `unified-sidebar-glass` panel is the surface.
            'gap-1.5 rounded-none border-0 border-b border-border/40 bg-transparent px-2 py-1.5'
          : // Right sidebar: matches the Details header; `InsetGlassSidebarShell` is the surface.
            'h-10 gap-1 rounded-none border-0 border-b border-border/30 bg-transparent px-3',
      )}
    >
      {/* Close button */}
      <div className="flex items-center shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={closePanel}
              className="h-7 w-7 p-0 touch-target-h7 text-muted-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] hover:text-foreground shrink-0 rounded-md"
              aria-label="Close terminal"
              iconOnly
            >
              <ChevronsRight className={`h-4 w-4 ${isBottom ? 'rotate-90' : ''}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide}>
            Close terminal
            <Kbd shortcutId="toggle-terminal" />
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Display mode switcher */}
      {!hideModeSwitcher && <TerminalModeSwitcher />}

      {/* Terminal Tabs (+ split control sits beside + inside TerminalTabs) */}
      {terminals.length > 0 && (
        <TerminalTabs
          terminals={terminals}
          activeTerminalId={activeTerminalId}
          cwds={terminalCwds}
          initialCwd={initialCwd}
          onSelectTerminal={onSelectTerminal}
          onCloseTerminal={onCloseTerminal}
          onCloseOtherTerminals={onCloseOtherTerminals}
          onCloseTerminalsToRight={onCloseTerminalsToRight}
          onCreateTerminal={onCreateTerminal}
          onRenameTerminal={onRenameTerminal}
          terminalSplitEnabled={terminalSplitEnabled}
          onAddSplitPane={onAddSplitPane}
          splitPaneTerminalIds={splitPaneTerminalIds}
          keyboardFocusTerminalId={keyboardFocusTerminalId}
          onCloseSplitGroup={onCloseSplitGroup}
        />
      )}
    </div>
  );
});
