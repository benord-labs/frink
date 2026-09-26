/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { Columns2, X, SquareTerminal, Plus } from 'lucide-react';
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { panelTabButtonClass } from '@/features/sidebar/panel-tab-button-class';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { resolveExternalTerminalPath } from './cwd-switch';
import {
  getVisibleTerminalTabsForStrip,
  isSplitStripTabActive,
  tabScrollTargetIdForActivePane,
} from './terminal-split-helpers';
import type { TerminalInstance } from './types';

/**
 * Get the shortened path (last folder name) from a full path
 */
function getShortPath(fullPath: string | undefined): string | null {
  if (!fullPath) return null;
  const parts = fullPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

type TerminalTabProps = {
  terminal: TerminalInstance;
  isActive: boolean;
  isOnly: boolean;
  isTruncated: boolean;
  cwd: string | undefined;
  initialCwd: string;
  isEditing: boolean;
  hasTabsToRight: boolean;
  canCloseOthers: boolean;
  /** This session is shown in one of the two split columns */
  showSplitPaneIndicator?: boolean;
  /** Use smaller text size for widget mode */
  small?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onRename: (id: string, name: string) => void;
  onEditingChange: (isEditing: boolean) => void;
  onStartRename: () => void;
  textRef: (el: HTMLSpanElement | null) => void;
};

const TerminalTab = memo(
  forwardRef<HTMLDivElement, TerminalTabProps>(function TerminalTab(
    {
      terminal,
      isActive,
      isOnly,
      isTruncated,
      cwd,
      initialCwd,
      isEditing,
      hasTabsToRight,
      canCloseOthers,
      showSplitPaneIndicator,
      small,
      onSelect,
      onClose,
      onCloseOthers,
      onCloseToRight,
      onRename,
      onEditingChange,
      onStartRename,
      textRef,
    },
    ref,
  ) {
    const openInTerminalMutation = trpc.external.openInTerminal.useMutation();

    // Only show path if it's different from initial cwd
    const isDifferentFromInitial = cwd && cwd !== initialCwd;
    const shortPath = isDifferentFromInitial ? getShortPath(cwd) : null;

    const [editValue, setEditValue] = useState(terminal.name);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleClick = useCallback(() => {
      if (!isEditing) {
        onSelect(terminal.id);
      }
    }, [onSelect, terminal.id, isEditing]);

    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        onStartRename();
      },
      [onStartRename],
    );

    const handleCloseClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onClose(terminal.id);
      },
      [onClose, terminal.id],
    );

    const handleOpenInExternalTerminal = useCallback(() => {
      const targetPath = resolveExternalTerminalPath(cwd, initialCwd);
      if (!targetPath) return;

      openInTerminalMutation.mutate(targetPath, {
        onSuccess: (result) => {
          if (!result.success) {
            toast.error(result.error);
          }
        },
        onError: (error) => {
          toast.error(`Failed to open external terminal: ${error.message}`);
        },
      });
    }, [cwd, initialCwd, openInTerminalMutation]);

    const handleSave = useCallback(() => {
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== terminal.name) {
        onRename(terminal.id, trimmed);
      }
      onEditingChange(false);
    }, [editValue, terminal.id, terminal.name, onRename, onEditingChange]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSave();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setEditValue(terminal.name);
          onEditingChange(false);
        }
      },
      [handleSave, terminal.name, onEditingChange],
    );

    const handleBlur = useCallback(() => {
      handleSave();
    }, [handleSave]);

    // Focus input when editing starts
    useEffect(() => {
      if (isEditing && inputRef.current) {
        setEditValue(terminal.name);
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
          }
        });
      }
    }, [isEditing, terminal.name]);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'group relative flex items-center shrink-0 select-none transition-colors',
              panelTabButtonClass(isActive, 'xs'),
              !isOnly ? 'cursor-pointer' : 'cursor-default',
              'outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring/70',
              'overflow-hidden whitespace-nowrap min-w-[50px] gap-1.5',
              isActive ? 'max-w-[180px]' : 'max-w-[150px]',
            )}
          >
            <div
              ref={ref}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleClick();
                }
              }}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              aria-label={
                showSplitPaneIndicator ? `${terminal.name}, visible in split panes` : terminal.name
              }
              className="flex items-center min-w-0 gap-1.5 flex-1"
            >
              {/* Terminal icon */}
              <div className="shrink-0 w-3.5 h-3.5 flex items-center justify-center">
                <SquareTerminal className="w-3.5 h-3.5 text-muted-foreground" />
              </div>

              {/* Terminal name or input */}
              {isEditing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={handleBlur}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Rename ${terminal.name}`}
                  className={cn(
                    'relative z-0 text-left flex-1 min-w-0 pr-1 bg-transparent outline-hidden border-none',
                    small ? 'text-xs' : 'text-sm',
                  )}
                />
              ) : (
                <span
                  ref={textRef}
                  className="relative z-0 text-left flex-1 min-w-0 pr-1 overflow-hidden flex items-center gap-1.5 whitespace-nowrap select-none cursor-[inherit]"
                >
                  <span>{terminal.name}</span>
                  {shortPath && <span className="text-muted-foreground">{shortPath}</span>}
                </span>
              )}

              {showSplitPaneIndicator && !isEditing && (
                <span
                  className="relative z-0 flex shrink-0 items-center text-muted-foreground"
                  title="Shown in split view"
                  aria-hidden
                >
                  <Columns2 className={small ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={2} />
                </span>
              )}

              {/* Gradient fade on the right when text is truncated */}
              {isTruncated && !isEditing && (
                <div
                  className={cn(
                    'absolute right-0 top-0 bottom-0 w-6 pointer-events-none z-1 rounded-r-md opacity-100 group-hover:opacity-0 transition-opacity duration-200',
                    isActive
                      ? 'bg-linear-to-l from-foreground/10 to-transparent'
                      : 'bg-linear-to-l from-card to-transparent',
                  )}
                />
              )}

              {/* Close button - only show when hovered and multiple tabs */}
            </div>
            {!isOnly && !isEditing && (
              <div className="absolute right-0 top-0 bottom-0 flex items-center justify-end pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 z-10">
                <div
                  className={cn(
                    'absolute right-0 top-0 bottom-0 w-9 flex items-center justify-center rounded-r-md',
                    isActive
                      ? 'bg-linear-to-l from-foreground/10 from-50% to-transparent'
                      : 'bg-linear-to-l from-card from-50% to-transparent',
                  )}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCloseClick}
                  className="relative z-20 size-auto hover:text-foreground hover:bg-transparent rounded p-0.5 transition-[color,transform] duration-150 ease-out active:scale-[0.97] focus-visible:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring/70"
                  aria-label="Close terminal"
                  iconOnly
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={onStartRename}>Rename terminal</ContextMenuItem>
          <ContextMenuItem onClick={handleOpenInExternalTerminal} disabled={!cwd && !initialCwd}>
            Open in external terminal
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onClose(terminal.id)} disabled={isOnly}>
            Close terminal
          </ContextMenuItem>
          <ContextMenuItem onClick={onCloseOthers} disabled={!canCloseOthers}>
            Close other terminals
          </ContextMenuItem>
          <ContextMenuItem onClick={onCloseToRight} disabled={!hasTabsToRight}>
            Close terminals to the right
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }),
);

type TerminalTabsProps = {
  terminals: readonly TerminalInstance[];
  activeTerminalId: string | null;
  cwds: Record<string, string>;
  initialCwd: string;
  /** Hide the plus button (when it's rendered externally) */
  hidePlusButton?: boolean;
  /** Use smaller text size for widget mode */
  small?: boolean;
  onSelectTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
  onCloseOtherTerminals: (id: string) => void;
  onCloseTerminalsToRight: (id: string) => void;
  onCreateTerminal: () => void;
  onRenameTerminal: (id: string, name: string) => void;
  /** Multi-pane strip active — tab split indicators when true. */
  terminalSplitEnabled?: boolean;
  /** Adds another column (repeatable); not a single-column toggle. */
  onAddSplitPane?: () => void;
  /** Session ids currently in the horizontal strip (for tab chrome). */
  splitPaneTerminalIds?: readonly string[];
  /** Which pane has xterm focus — keeps split badge highlighted when a non-primary pane is focused. */
  keyboardFocusTerminalId?: string | null;
  /** Close every session in the split strip (group tab close). */
  onCloseSplitGroup?: () => void;
};

export const TerminalTabs = memo(function TerminalTabs({
  terminals,
  activeTerminalId,
  cwds,
  initialCwd,
  hidePlusButton = false,
  small = false,
  onSelectTerminal,
  onCloseTerminal,
  onCloseOtherTerminals,
  onCloseTerminalsToRight,
  onCreateTerminal,
  onRenameTerminal,
  terminalSplitEnabled = false,
  onAddSplitPane,
  splitPaneTerminalIds = [],
  keyboardFocusTerminalId = null,
  onCloseSplitGroup,
}: TerminalTabsProps) {
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const textRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const [truncatedTabs, setTruncatedTabs] = useState<Set<string>>(new Set());
  const [showLeftGradient, setShowLeftGradient] = useState(false);
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);

  const visibleTabs = useMemo(
    () => getVisibleTerminalTabsForStrip(terminals, splitPaneTerminalIds),
    [terminals, splitPaneTerminalIds],
  );

  const visibleTabIdsKey = useMemo(() => visibleTabs.map((t) => t.id).join('\0'), [visibleTabs]);

  const isOnly = visibleTabs.length === 1;

  const handleTabClose = useCallback(
    (terminalId: string) => {
      if (
        onCloseSplitGroup &&
        splitPaneTerminalIds.length >= 2 &&
        terminalId === splitPaneTerminalIds[0]
      ) {
        onCloseSplitGroup();
        return;
      }
      onCloseTerminal(terminalId);
    },
    [onCloseSplitGroup, onCloseTerminal, splitPaneTerminalIds],
  );

  const handleStartRename = useCallback((terminalId: string) => {
    setEditingTerminalId(terminalId);
  }, []);

  const handleEditingChange = useCallback((terminalId: string, isEditing: boolean) => {
    setEditingTerminalId(isEditing ? terminalId : null);
  }, []);

  // Check scroll position for gradients
  const checkScrollPosition = useCallback(() => {
    const container = tabsContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const isScrollable = scrollWidth > clientWidth;

    setShowLeftGradient(isScrollable && scrollLeft > 0);
  }, []);

  // Update gradients on scroll
  useEffect(() => {
    const container = tabsContainerRef.current;
    if (!container) return;

    checkScrollPosition();

    container.addEventListener('scroll', checkScrollPosition, { passive: true });
    return () => container.removeEventListener('scroll', checkScrollPosition);
  }, [checkScrollPosition]);

  // Update gradients when tabs change
  useEffect(() => {
    checkScrollPosition();
  }, [checkScrollPosition]);

  // Update gradients on window resize
  useEffect(() => {
    const handleResize = () => checkScrollPosition();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [checkScrollPosition]);

  const scrollTabTargetId = tabScrollTargetIdForActivePane(
    activeTerminalId,
    keyboardFocusTerminalId,
    splitPaneTerminalIds,
  );

  // Scroll to active tab when it changes (split group uses primary tab ref)
  useEffect(() => {
    if (!scrollTabTargetId || !tabsContainerRef.current) return;

    const container = tabsContainerRef.current;
    const activeTabElement = tabRefs.current.get(scrollTabTargetId);

    if (activeTabElement) {
      setTimeout(() => {
        const containerRect = container.getBoundingClientRect();
        const tabRect = activeTabElement.getBoundingClientRect();

        const isTabLeftOfView = tabRect.left < containerRect.left;
        const isTabRightOfView = tabRect.right > containerRect.right;

        if (isTabLeftOfView || isTabRightOfView) {
          const tabCenter = activeTabElement.offsetLeft + activeTabElement.offsetWidth / 2;
          const containerCenter = container.offsetWidth / 2;
          const targetScroll = tabCenter - containerCenter;
          const maxScroll = container.scrollWidth - container.offsetWidth;
          const clampedScroll = Math.max(0, Math.min(targetScroll, maxScroll));

          container.scrollTo({
            left: clampedScroll,
            behavior: 'smooth',
          });
        }
      }, 0);
    }
  }, [scrollTabTargetId]);

  // Check if text is truncated for each tab (re-observe when tab ids change — refs attach after paint)
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleTabIdsKey intentionally retriggers when tab set changes; body reads refs filled after paint
  useEffect(() => {
    const checkTruncation = () => {
      const newTruncated = new Set<string>();
      textRefs.current.forEach((el, terminalId) => {
        if (el && el.scrollWidth > el.clientWidth) {
          newTruncated.add(terminalId);
        }
      });
      setTruncatedTabs(newTruncated);
    };

    checkTruncation();

    const resizeObserver = new ResizeObserver(() => checkTruncation());
    textRefs.current.forEach((el) => {
      if (el) {
        resizeObserver.observe(el);
      }
    });

    return () => resizeObserver.disconnect();
  }, [visibleTabIdsKey]);

  // Cleanup refs for closed tabs to prevent memory leaks
  useEffect(() => {
    const openIds = new Set(terminals.map((t) => t.id));

    tabRefs.current.forEach((_, id) => {
      if (!openIds.has(id)) {
        tabRefs.current.delete(id);
        textRefs.current.delete(id);
      }
    });
  }, [terminals]);

  return (
    <div className="relative flex-1 min-w-0 flex items-center h-7">
      {/* Left gradient */}
      {showLeftGradient && (
        <div className="absolute left-0 top-0 bottom-0 w-8 pointer-events-none z-30 bg-linear-to-r from-card to-transparent" />
      )}

      {/* Scrollable tabs container - with padding-right for plus button */}
      <div
        ref={tabsContainerRef}
        role="tablist"
        className={cn(
          'flex items-center px-1 py-1 -my-1 gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-hide',
          !hidePlusButton && (onAddSplitPane ? 'pr-17' : 'pr-12'),
        )}
        style={{
          // @ts-expect-error - WebKit-specific property for Electron
          // biome-ignore lint/style/useNamingConvention: WebKit CSS property name
          WebkitAppRegion: 'no-drag',
        }}
      >
        {visibleTabs.map((terminal, index) => {
          const hasTabsToRight = index < visibleTabs.length - 1;
          const canCloseOthers = visibleTabs.length > 1;
          const isStripPrimary =
            Boolean(terminalSplitEnabled) &&
            splitPaneTerminalIds.length >= 2 &&
            terminal.id === splitPaneTerminalIds[0];
          const showSplitPaneIndicator = isStripPrimary;
          const isActive =
            isSplitStripTabActive(
              terminal.id,
              activeTerminalId,
              keyboardFocusTerminalId,
              splitPaneTerminalIds,
            ) || terminal.id === activeTerminalId;

          return (
            <TerminalTab
              key={terminal.id}
              ref={(el) => {
                if (el) {
                  tabRefs.current.set(terminal.id, el);
                } else {
                  tabRefs.current.delete(terminal.id);
                }
              }}
              terminal={terminal}
              isActive={isActive}
              isOnly={isOnly}
              isTruncated={truncatedTabs.has(terminal.id)}
              cwd={cwds[terminal.paneId]}
              initialCwd={initialCwd}
              isEditing={editingTerminalId === terminal.id}
              hasTabsToRight={hasTabsToRight}
              canCloseOthers={canCloseOthers}
              showSplitPaneIndicator={showSplitPaneIndicator}
              small={small}
              onSelect={onSelectTerminal}
              onClose={handleTabClose}
              onCloseOthers={() => onCloseOtherTerminals(terminal.id)}
              onCloseToRight={() => onCloseTerminalsToRight(terminal.id)}
              onRename={onRenameTerminal}
              onEditingChange={(isEditing) => handleEditingChange(terminal.id, isEditing)}
              onStartRename={() => handleStartRename(terminal.id)}
              textRef={(el) => {
                if (el) {
                  textRefs.current.set(terminal.id, el);
                } else {
                  textRefs.current.delete(terminal.id);
                }
              }}
            />
          );
        })}
      </div>

      {/* Split + new — absolute right (VS Code–style cluster) */}
      {!hidePlusButton && (
        <div
          className="absolute right-0 top-0 bottom-0 z-20 flex items-center"
          style={{
            // @ts-expect-error - WebKit-specific property for Electron
            // biome-ignore lint/style/useNamingConvention: WebKit CSS property name
            WebkitAppRegion: 'no-drag',
          }}
        >
          <div className="h-full w-7 bg-linear-to-r from-transparent to-card" />
          <div className="flex h-full items-center gap-0.5 bg-transparent pr-1">
            {onAddSplitPane && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    onClick={onAddSplitPane}
                    className="touch-target-h6 rounded-md transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]"
                    aria-label="Split terminal"
                  >
                    <Columns2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Split terminal</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onCreateTerminal}
                  className="touch-target-h6 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
                  aria-label="New terminal"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">New terminal</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
});
