/* eslint-disable max-lines, max-lines-per-function */
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTheme } from 'next-themes';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Terminal as XTerm } from 'xterm';
import { activePaletteAtom } from '@/lib/themes/palette/theme-atoms';
import { getTerminalTheme } from '@/lib/themes/terminal-theme';
import { trpc } from '@/lib/trpc';
import { terminalCwdAtom } from './atoms';
import { sanitizeForTitle } from './commandBuffer';
import { buildCdCommand, getCwdSwitchDecision } from './cwd-switch';
import {
  createTerminalInstance,
  setupClickToMoveCursor,
  setupContextMenuHandler,
  setupFocusListener,
  setupKeyboardHandler,
  setupPasteHandler,
  setupResizeHandlers,
} from './helpers';
import { isXtermTextareaFocused } from './is-xterm-textarea-focused';
import { parseCwd } from './parseCwd';
import { TerminalSearch } from './TerminalSearch';
import { TerminalCwdSwitchDialog } from './terminal-cwd-switch-dialog';
import type { TerminalProps, TerminalStreamEvent } from './types';
import { shellEscapePaths } from './utils';
import 'xterm/css/xterm.css';

type DirectorySwitchResult = 'switched' | 'blocked-pending-input' | 'blocked-invalid';

function TerminalInner({
  paneId,
  terminalId,
  cwd,
  workspaceId,
  tabId,
  initialCommands,
  initialCwd,
  isKeyboardTarget = true,
  isPaneActive = true,
  onTerminalPaneFocused,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const isExitedRef = useRef(false);
  const commandBufferRef = useRef('');

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState<string | null>(initialCwd || cwd);
  const [isCwdSwitchDialogOpen, setIsCwdSwitchDialogOpen] = useState(false);
  const [pendingCwdSwitch, setPendingCwdSwitch] = useState<string | null>(null);
  const setGlobalCwds = useSetAtom(terminalCwdAtom);

  // xterm theme from the committed palette (null until the first apply), else next-themes' mode
  const { resolvedTheme } = useTheme();
  const palette = useAtomValue(activePaletteAtom);
  const isDark = resolvedTheme === 'dark';
  const theme = useMemo(() => getTerminalTheme(isDark, palette), [isDark, palette]);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Ref for terminalCwd to avoid effect re-runs when cwd changes
  const terminalCwdRef = useRef(terminalCwd);
  terminalCwdRef.current = terminalCwd;
  const mountCwdRef = useRef(cwd);
  const requestedCwdRef = useRef(initialCwd || cwd);
  const propCwdRef = useRef(cwd);
  propCwdRef.current = cwd;
  const propInitialCwdRef = useRef(initialCwd);
  propInitialCwdRef.current = initialCwd;
  const dismissedCwdRef = useRef<string | null>(null);
  const hasUserInteractedRef = useRef(false);
  const hasPendingInputRef = useRef(false);

  // Ref for paneId to use in callbacks
  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const onTerminalPaneFocusedRef = useRef(onTerminalPaneFocused);
  onTerminalPaneFocusedRef.current = onTerminalPaneFocused;
  const isPaneActiveRef = useRef(isPaneActive);
  isPaneActiveRef.current = isPaneActive;
  const sessionIdentity = `${workspaceId}:${tabId}:${paneId}`;

  // Reset cwd-related state whenever terminal session identity changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: paneId changes are encoded in sessionIdentity
  useEffect(() => {
    // Include sessionIdentity in deps to reset on session changes; value intentionally unused.
    void sessionIdentity;
    const nextSessionCwd = propInitialCwdRef.current || propCwdRef.current;
    terminalCwdRef.current = nextSessionCwd;
    mountCwdRef.current = nextSessionCwd;
    requestedCwdRef.current = nextSessionCwd;
    dismissedCwdRef.current = null;
    hasUserInteractedRef.current = false;
    hasPendingInputRef.current = false;

    setTerminalCwd(nextSessionCwd);
    setPendingCwdSwitch(null);
    setIsCwdSwitchDialogOpen(false);
    setGlobalCwds((prev) => ({
      ...prev,
      [paneId]: nextSessionCwd,
    }));
  }, [sessionIdentity, setGlobalCwds]);

  // Mutations
  const createOrAttachMutation = trpc.terminal.createOrAttach.useMutation();
  const writeMutation = trpc.terminal.write.useMutation();
  const resizeMutation = trpc.terminal.resize.useMutation();
  const detachMutation = trpc.terminal.detach.useMutation();
  const clearScrollbackMutation = trpc.terminal.clearScrollback.useMutation();

  // Refs for mutations to avoid effect re-runs
  const createOrAttachRef = useRef(createOrAttachMutation.mutate);
  const writeRef = useRef(writeMutation.mutate);
  const resizeRef = useRef(resizeMutation.mutate);
  const detachRef = useRef(detachMutation.mutate);
  const clearScrollbackRef = useRef(clearScrollbackMutation.mutate);
  createOrAttachRef.current = createOrAttachMutation.mutate;
  writeRef.current = writeMutation.mutate;
  resizeRef.current = resizeMutation.mutate;
  detachRef.current = detachMutation.mutate;
  clearScrollbackRef.current = clearScrollbackMutation.mutate;

  // Parse terminal data for cwd (OSC 7 sequences)
  const updateCwdFromData = useCallback(
    (data: string) => {
      const parsedCwd = parseCwd(data);
      if (parsedCwd !== null) {
        setTerminalCwd(parsedCwd);
        // Also update global atom for the tabs to show
        setGlobalCwds((prev) => ({
          ...prev,
          [paneIdRef.current]: parsedCwd,
        }));
      }
    },
    [setGlobalCwds],
  );

  const updateCwdRef = useRef(updateCwdFromData);
  updateCwdRef.current = updateCwdFromData;

  const applyDirectorySwitch = useCallback(
    (targetCwd: string): DirectorySwitchResult => {
      if (!targetCwd) return 'blocked-invalid';
      const isExited = isExitedRef.current;
      if (!isExited && hasPendingInputRef.current) return 'blocked-pending-input';

      requestedCwdRef.current = targetCwd;
      dismissedCwdRef.current = null;
      terminalCwdRef.current = targetCwd;
      mountCwdRef.current = targetCwd;
      setTerminalCwd(targetCwd);
      setGlobalCwds((prev) => ({
        ...prev,
        [paneIdRef.current]: targetCwd,
      }));
      hasUserInteractedRef.current = true;
      hasPendingInputRef.current = false;

      if (isExited) return 'switched';

      writeRef.current({ paneId, data: buildCdCommand(targetCwd) });
      return 'switched';
    },
    [paneId, setGlobalCwds],
  );

  // Handle stream data
  const handleStreamData = useCallback((event: TerminalStreamEvent) => {
    if (!xtermRef.current) return;

    if (event.type === 'data' && event.data) {
      xtermRef.current.write(event.data);
      updateCwdRef.current(event.data);
    } else if (event.type === 'exit') {
      isExitedRef.current = true;
      xtermRef.current.writeln(`\r\n\r\n[Process exited with code ${event.exitCode}]`);
      xtermRef.current.writeln('[Press any key to restart]');
    }
  }, []);

  // Subscribe to terminal output
  trpc.terminal.stream.useSubscription(paneId, {
    onData: handleStreamData,
    onError: (err) => {
      xtermRef.current?.write(`\r\n\x1b[31m[Connection error: ${err.message}]\x1b[0m\r\n`);
    },
    enabled: true,
  });

  // Initialize terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isUnmounted = false;
    const { xterm, fitAddon, serializeAddon, cleanup } = createTerminalInstance(container, {
      cwd: terminalCwdRef.current || mountCwdRef.current,
      initialTheme: themeRef.current,
      onFileLinkClick: (_path, _line, _column) => {
        // TODO: Open file in editor
      },
      onUrlClick: (url) => {
        window.desktopApi.openExternal(url);
      },
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;
    isExitedRef.current = false;

    // Lazy load search addon
    import('@xterm/addon-search').then(({ SearchAddon }) => {
      if (isUnmounted || !xtermRef.current) return;
      const searchAddon = new SearchAddon();
      xtermRef.current.loadAddon(searchAddon);
      searchAddonRef.current = searchAddon;
    });

    // Apply serialized state from server
    const applySerializedState = (serializedState: string) => {
      if (serializedState) {
        xterm.write(serializedState);
      }
    };

    // Restart terminal after exit
    const restartTerminal = () => {
      isExitedRef.current = false;
      xterm.clear();
      const restartCwd = requestedCwdRef.current || terminalCwdRef.current || mountCwdRef.current;
      createOrAttachRef.current(
        {
          paneId,
          tabId,
          workspaceId,
          cols: xterm.cols,
          rows: xterm.rows,
          cwd: restartCwd,
        },
        {
          onSuccess: (result) => {
            applySerializedState(result.serializedState);
          },
        },
      );
    };

    // Input handler
    const handleTerminalInput = (data: string) => {
      if (isExitedRef.current) {
        restartTerminal();
        return;
      }
      hasUserInteractedRef.current = true;
      if (data.includes('\r') || data.includes('\n')) {
        hasPendingInputRef.current = false;
      } else {
        hasPendingInputRef.current = true;
      }
      writeRef.current({ paneId, data });
    };

    // Key handler for command buffer (tab title)
    const handleKeyPress = (event: { key: string; domEvent: KeyboardEvent }) => {
      const { domEvent } = event;
      if (domEvent.key === 'Enter') {
        const title = sanitizeForTitle(commandBufferRef.current);
        if (title) {
          // TODO: Set tab title
        }
        commandBufferRef.current = '';
        hasPendingInputRef.current = false;
      } else if (domEvent.key === 'Backspace') {
        commandBufferRef.current = commandBufferRef.current.slice(0, -1);
        hasPendingInputRef.current = commandBufferRef.current.length > 0;
      } else if (domEvent.key === 'c' && domEvent.ctrlKey) {
        commandBufferRef.current = '';
        hasPendingInputRef.current = false;
      } else if (domEvent.key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey) {
        commandBufferRef.current += domEvent.key;
        hasPendingInputRef.current = true;
      }
    };

    // Create or attach to session
    createOrAttachRef.current(
      {
        paneId,
        tabId,
        workspaceId,
        cols: xterm.cols,
        rows: xterm.rows,
        cwd: initialCwd || mountCwdRef.current,
        initialCommands,
      },
      {
        onSuccess: (result) => {
          applySerializedState(result.serializedState);
          if (isPaneActiveRef.current !== false) {
            xterm.focus();
          }
        },
        onError: (err) => {
          xterm.write(`\x1b[31m[Failed to start terminal: ${err.message}]\x1b[0m\r\n`);
        },
      },
    );

    // Set up handlers
    const inputDisposable = xterm.onData(handleTerminalInput);
    const keyDisposable = xterm.onKey(handleKeyPress);

    const handleClear = () => {
      xterm.clear();
      clearScrollbackRef.current({ paneId });
    };

    const handleWrite = (data: string) => {
      if (!isExitedRef.current) {
        hasUserInteractedRef.current = true;
        hasPendingInputRef.current = !data.includes('\r') && !data.includes('\n');
        writeRef.current({ paneId, data });
      }
    };

    const cleanupKeyboard = setupKeyboardHandler(xterm, {
      onShiftEnter: () => handleWrite('\x1b\r'), // ESC + CR for line continuation
      onClear: handleClear,
    });

    const cleanupClickToMove = setupClickToMoveCursor(xterm, {
      onWrite: handleWrite,
    });

    const cleanupFocus = setupFocusListener(xterm, () => {
      const id = terminalIdRef.current;
      if (id) onTerminalPaneFocusedRef.current?.(id);
    });

    const cleanupResize = setupResizeHandlers(container, xterm, fitAddon, (cols, rows) => {
      resizeRef.current({ paneId, cols, rows });
    });

    const cleanupPaste = setupPasteHandler(xterm, {
      onPaste: (text) => {
        commandBufferRef.current += text;
        hasUserInteractedRef.current = true;
        hasPendingInputRef.current = !text.includes('\r') && !text.includes('\n');
      },
    });

    const cleanupContextMenu = setupContextMenuHandler(xterm, {
      onCopy: () => {
        toast.success('Copied to clipboard');
      },
      onPaste: (text) => {
        commandBufferRef.current += text;
        hasUserInteractedRef.current = true;
        hasPendingInputRef.current = !text.includes('\r') && !text.includes('\n');
      },
      onError: () => {
        toast.error('Clipboard access denied');
      },
    });

    // Cleanup on unmount
    return () => {
      isUnmounted = true;
      inputDisposable.dispose();
      keyDisposable.dispose();
      cleanupKeyboard();
      cleanupClickToMove();
      cleanupFocus?.();
      cleanupResize();
      cleanupPaste();
      cleanupContextMenu();
      cleanup();
      const serializedState = serializeAddon.serialize();

      // Detach instead of kill - keeps session alive for reattach
      detachRef.current({ paneId, serializedState });
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      serializeAddonRef.current = null;
    };
    // Note: terminalCwd is accessed via ref to avoid remounting on cwd changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, workspaceId, tabId, initialCwd, initialCommands]);

  // Split PTY columns only: depend on `isKeyboardTarget` — not `isPaneActive`. If `isPaneActive`
  // were in this deps array, switching chat panes would re-run and steal focus from the composer.
  // Also: do not *schedule* rAF while inactive — a deferred rAF could run after the user activates
  // the pane and still focus xterm (stale rAF). Callback keeps a second guard for active→inactive.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    const ta = xterm.textarea;
    const targetOn = isKeyboardTarget !== false;
    if (targetOn) {
      if (isPaneActiveRef.current === false) {
        return;
      }
      if (isXtermTextareaFocused(ta ?? null, document.activeElement)) {
        return;
      }
      requestAnimationFrame(() => {
        if (isPaneActiveRef.current === false) return;
        xtermRef.current?.focus();
      });
    } else if (ta && document.activeElement === ta) {
      ta.blur();
    }
  }, [isKeyboardTarget]);

  // Split-chat: blur when this column becomes inactive — separate deps so we never rAF-focus on
  // isPaneActive true alone (e.g. user switched to this pane to use the chat).
  useEffect(() => {
    if (isPaneActive !== false) return;
    const xterm = xtermRef.current;
    const ta = xterm?.textarea;
    if (ta && document.activeElement === ta) {
      ta.blur();
    }
  }, [isPaneActive]);

  useEffect(() => {
    const nextCwd = cwd;
    if (nextCwd && isExitedRef.current) {
      applyDirectorySwitch(nextCwd);
      return;
    }

    const decision = getCwdSwitchDecision({
      nextCwd,
      requestedCwd: requestedCwdRef.current,
      dismissedCwd: dismissedCwdRef.current,
      currentTerminalCwd: terminalCwdRef.current,
      hasUserInteracted: hasUserInteractedRef.current,
      hasPendingInput: hasPendingInputRef.current,
    });

    if (!nextCwd || decision === 'ignore') {
      if (nextCwd && terminalCwdRef.current === nextCwd) {
        requestedCwdRef.current = nextCwd;
        dismissedCwdRef.current = null;
      }
      return;
    }

    if (decision === 'auto') {
      const result = applyDirectorySwitch(nextCwd);
      if (result === 'blocked-pending-input') {
        setPendingCwdSwitch(nextCwd);
        setIsCwdSwitchDialogOpen(true);
      }
      return;
    }

    setPendingCwdSwitch(nextCwd);
    setIsCwdSwitchDialogOpen(true);
  }, [cwd, applyDirectorySwitch]);

  const handleKeepCurrentDirectory = useCallback(() => {
    if (pendingCwdSwitch) {
      dismissedCwdRef.current = pendingCwdSwitch;
    }
    setIsCwdSwitchDialogOpen(false);
    setPendingCwdSwitch(null);
  }, [pendingCwdSwitch]);

  const handleMoveDirectory = useCallback(() => {
    if (!pendingCwdSwitch) {
      setIsCwdSwitchDialogOpen(false);
      setPendingCwdSwitch(null);
      return;
    }

    const result = applyDirectorySwitch(pendingCwdSwitch);
    if (result === 'blocked-pending-input') {
      toast.error('Finish or clear the current command before switching directories.');
      return;
    }
    if (result !== 'switched') {
      return;
    }
    setIsCwdSwitchDialogOpen(false);
    setPendingCwdSwitch(null);
  }, [applyDirectorySwitch, pendingCwdSwitch]);

  const handleDetachTerminal = useCallback(() => {
    const serializedState = serializeAddonRef.current?.serialize();
    detachRef.current({ paneId, serializedState });

    if (pendingCwdSwitch) {
      dismissedCwdRef.current = pendingCwdSwitch;
    }
    setIsCwdSwitchDialogOpen(false);
    setPendingCwdSwitch(null);
  }, [paneId, pendingCwdSwitch]);

  const handleCwdDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open && pendingCwdSwitch) {
        handleKeepCurrentDirectory();
        return;
      }
      setIsCwdSwitchDialogOpen(open);
    },
    [pendingCwdSwitch, handleKeepCurrentDirectory],
  );

  // Repaint on a theme change without recreating the terminal
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = theme;
  }, [theme]);

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || !containerRef.current?.contains(target)) {
        return;
      }
      if (e.key === 'f' && e.metaKey && !e.shiftKey) {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Drag and drop files
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;

      // Get file paths (Electron exposes webUtils)
      const paths = files.map((file) => {
        return window.webUtils?.getPathForFile?.(file) || file.name;
      });
      const text = shellEscapePaths(paths);

      if (!isExitedRef.current) {
        hasUserInteractedRef.current = true;
        hasPendingInputRef.current = !text.includes('\r') && !text.includes('\n');
        writeRef.current({ paneId, data: text });
      }
    },
    [paneId],
  );

  return (
    <div
      role="application"
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: theme.background }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <TerminalSearch
        searchAddon={searchAddonRef.current}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
      {pendingCwdSwitch && (
        <TerminalCwdSwitchDialog
          open={isCwdSwitchDialogOpen}
          nextCwd={pendingCwdSwitch}
          onOpenChange={handleCwdDialogOpenChange}
          onMoveDirectory={handleMoveDirectory}
          onKeepCurrent={handleKeepCurrentDirectory}
          onDetachTerminal={handleDetachTerminal}
        />
      )}
      <div ref={containerRef} className="h-full w-full" style={{ padding: '8px' }} />
    </div>
  );
}

TerminalInner.displayName = 'Terminal';

export const Terminal = memo(TerminalInner);
