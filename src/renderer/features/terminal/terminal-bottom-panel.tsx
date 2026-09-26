/* eslint-disable max-lines, max-lines-per-function */
import { useAtom } from 'jotai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { terminalBottomHeightAtom } from './atoms';
import { TerminalContent } from './terminal-content';
import { TerminalPanelHeader } from './terminal-panel-header';
import { useTerminalManager } from './use-terminal-manager';

const MIN_HEIGHT = 150;
/** Absolute cap — clamped further by viewport in the resize logic */
const STATIC_MAX_HEIGHT = 600;
/** Default height used when resetting via double-click */
const DEFAULT_HEIGHT = 300;
/** Keyboard arrow step (px); shift multiplies by 5 */
const RESIZE_STEP = 10;

/** Clamp height to [MIN_HEIGHT, min(STATIC_MAX_HEIGHT, 70% viewport)] */
function clampHeight(h: number): number {
  const viewportMax = Math.round(window.innerHeight * 0.7);
  return Math.min(STATIC_MAX_HEIGHT, viewportMax, Math.max(MIN_HEIGHT, h));
}

type TerminalBottomPanelProps = {
  chatId: string;
  cwd: string;
  workspaceId: string;
  tabId?: string;
  initialCommands?: string[];
  /** When true, auto-creates the first terminal on open. Default false (sidebar handles it). */
  autoCreate?: boolean;
  /** When true, hides the sidebar/bottom mode switcher (e.g. new-chat has no sidebar). */
  hideModeSwitcher?: boolean;
  /** Split-chat: false when this chat column is inactive. Defaults to true. */
  isPaneActive?: boolean;
};

/**
 * Terminal rendered as a resizable bottom panel.
 * Only mounts when terminalDisplayModeAtom === 'bottom' and the terminal is open.
 */
export function TerminalBottomPanel({
  chatId,
  cwd,
  workspaceId,
  tabId,
  initialCommands,
  autoCreate = false,
  hideModeSwitcher = false,
  isPaneActive = true,
}: TerminalBottomPanelProps) {
  // Persisted height — only written on drag end or keyboard resize (not every pointermove)
  const [persistedHeight, setPersistedHeight] = useAtom(terminalBottomHeightAtom);
  // Local visual height — drives rendering during drag without localStorage writes
  const [visualHeight, setVisualHeight] = useState(() => clampHeight(persistedHeight));

  // Sync visual height when persisted height changes externally (e.g. another window)
  useEffect(() => {
    setVisualHeight(clampHeight(persistedHeight));
  }, [persistedHeight]);

  const {
    isOpen,
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
  } = useTerminalManager({ chatId, skipKeyboardShortcut: true, skipAutoCreate: !autoCreate });

  // ---- Vertical resize logic ----
  const isResizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const rafRef = useRef<number>(0);
  // Store listener refs for cleanup on unmount
  const moveListenerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const upListenerRef = useRef<((e: PointerEvent) => void) | null>(null);

  /** Remove document-level listeners and reset cursor / user-select */
  const cleanupResize = useCallback(() => {
    isResizingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (moveListenerRef.current) {
      document.removeEventListener('pointermove', moveListenerRef.current);
      moveListenerRef.current = null;
    }
    if (upListenerRef.current) {
      document.removeEventListener('pointerup', upListenerRef.current);
      upListenerRef.current = null;
    }
  }, []);

  // Cleanup on unmount (e.g. mode switch mid-drag)
  useEffect(() => cleanupResize, [cleanupResize]);

  // Re-clamp height when the window is resized (prevents panel crushing the chat area)
  useEffect(() => {
    const handleWindowResize = () => {
      setVisualHeight((h) => clampHeight(h));
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      isResizingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = visualHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (!isResizingRef.current) return;
        // Throttle visual updates to one per frame
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const delta = startYRef.current - moveEvent.clientY;
          setVisualHeight(clampHeight(startHeightRef.current + delta));
        });
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        // Compute final height from pointer coords — avoids stale closure over visualHeight
        const delta = startYRef.current - upEvent.clientY;
        setPersistedHeight(clampHeight(startHeightRef.current + delta));
        cleanupResize();
      };

      moveListenerRef.current = onPointerMove;
      upListenerRef.current = onPointerUp;
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    },
    [visualHeight, setPersistedHeight, cleanupResize],
  );

  /** Arrow Up/Down to resize via keyboard; Shift for larger steps */
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? RESIZE_STEP * 5 : RESIZE_STEP;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = clampHeight(visualHeight + step);
        setVisualHeight(next);
        setPersistedHeight(next);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = clampHeight(visualHeight - step);
        setVisualHeight(next);
        setPersistedHeight(next);
      }
    },
    [visualHeight, setPersistedHeight],
  );

  /** Double-click resets to default height */
  const handleResizeDoubleClick = useCallback(() => {
    const reset = clampHeight(DEFAULT_HEIGHT);
    setVisualHeight(reset);
    setPersistedHeight(reset);
  }, [setPersistedHeight]);

  // Parent already guards displayMode === 'bottom'; only check open state here
  if (!isOpen) {
    return null;
  }

  const effectiveMaxHeight = Math.min(STATIC_MAX_HEIGHT, Math.round(window.innerHeight * 0.7));

  return (
    <div
      className="mx-1 mb-1 flex shrink-0 flex-col overflow-hidden rounded-xl shadow-xs unified-sidebar-glass"
      style={{ height: visualHeight, maxHeight: '70vh' }}
    >
      {/* Top resize handle — visual height is 4px but padding expands touch target to 12px */}
      {/* biome-ignore lint/a11y/useSemanticElements: custom drag handle, not a true <hr> separator */}
      <div
        className="h-1 cursor-row-resize shrink-0 rounded-t-xl py-1 transition-colors hover:bg-foreground/5"
        style={{ touchAction: 'none' }}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        onDoubleClick={handleResizeDoubleClick}
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-valuenow={visualHeight}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={effectiveMaxHeight}
        aria-label="Resize terminal panel"
      />

      {/* Header with tabs */}
      <TerminalPanelHeader
        orientation="bottom"
        closePanel={closePanel}
        terminals={terminals}
        activeTerminalId={activeTerminalId}
        terminalCwds={terminalCwds}
        initialCwd={cwd}
        onSelectTerminal={selectTerminal}
        onCloseTerminal={closeTerminal}
        onCloseOtherTerminals={closeOtherTerminals}
        onCloseTerminalsToRight={closeTerminalsToRight}
        onCreateTerminal={createTerminal}
        onRenameTerminal={renameTerminal}
        hideModeSwitcher={hideModeSwitcher}
        terminalSplitEnabled={terminalSplitEnabled}
        onAddSplitPane={addSplitPane}
        splitPaneTerminalIds={splitPaneTerminalIds}
        keyboardFocusTerminalId={keyboardFocusTerminalId}
        onCloseSplitGroup={closeSplitGroup}
      />

      {/* Terminal Content */}
      <TerminalContent
        activeTerminal={activeTerminal}
        splitPaneTerminals={splitPaneTerminals}
        terminalKeyboardTargetId={terminalKeyboardTargetId}
        onTerminalPaneFocused={setTerminalKeyboardFocus}
        onCloseSplitPane={closeTerminal}
        canRenderTerminal={canRenderTerminal}
        terminalBg={terminalBg}
        cwd={cwd}
        workspaceId={workspaceId}
        tabId={tabId}
        initialCommands={initialCommands}
        surfaceClassName="rounded-b-xl border-t border-border/40"
        isPaneActive={isPaneActive}
      />
    </div>
  );
}
