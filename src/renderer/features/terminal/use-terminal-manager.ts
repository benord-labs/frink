/* eslint-disable max-lines, max-lines-per-function */
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { splitViewAtom } from '@/features/agents/atoms';
import { focusChatInput } from '@/lib/focus-chat-input';
import { activePaletteAtom } from '@/lib/themes/palette/theme-atoms';
import { getTerminalTheme } from '@/lib/themes/terminal-theme';
import { trpc } from '@/lib/trpc';
import { runChatShortcutAction } from '@/lib/work-queue/chat-owns-keyboard-shortcuts';
import {
  activeTerminalIdAtom,
  terminalCwdsForChatAtomFamily,
  terminalDisplayModeAtom,
  terminalSidebarOpenAtomFamily,
  terminalSplitKeyboardFocusIdAtomFamily,
  terminalSplitPaneIdsAtomFamily,
  terminalsAtom,
} from './atoms';
import { generatePaneId, generateTerminalId, getNextTerminalName } from './helpers';
import { killTerminalPanesByIds } from './kill-terminal-panes';
import {
  getSplitPaneTerminalsForContent,
  getVisibleTerminalTabsForStrip,
  normalizeSplitPaneIds,
  resolveSplitPaneInstances,
} from './terminal-split-helpers';
import type { TerminalInstance } from './types';

function toastKillFailures(errors: string[], label: string) {
  if (errors.length === 0) return;
  const head = errors.slice(0, 3).join('; ');
  const more = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
  toast.error(`${label}: ${errors.length} failed — ${head}${more}`);
}

type UseTerminalManagerOptions = {
  chatId: string;
  /** Skip registering the Cmd+J keyboard shortcut (avoid duplicate handlers) */
  skipKeyboardShortcut?: boolean;
  /** Skip auto-creating the first terminal on open (avoid duplicate creation race) */
  skipAutoCreate?: boolean;
};

/**
 * Shared terminal management logic for both sidebar and bottom panel modes.
 * Handles terminal CRUD, selection, background colour, and open state.
 */
export function useTerminalManager({
  chatId,
  skipKeyboardShortcut = false,
  skipAutoCreate = false,
}: UseTerminalManagerOptions) {
  const terminalSidebarAtom = useMemo(() => terminalSidebarOpenAtomFamily(chatId), [chatId]);
  const splitPaneIdsAtom = useMemo(() => terminalSplitPaneIdsAtomFamily(chatId), [chatId]);
  const splitKeyboardFocusAtom = useMemo(
    () => terminalSplitKeyboardFocusIdAtomFamily(chatId),
    [chatId],
  );
  const terminalCwdsAtomForChat = useMemo(() => terminalCwdsForChatAtomFamily(chatId), [chatId]);

  const [isOpen, setIsOpen] = useAtom(terminalSidebarAtom);
  const [allTerminals, setAllTerminals] = useAtom(terminalsAtom);
  const [allActiveIds, setAllActiveIds] = useAtom(activeTerminalIdAtom);
  const [splitPaneIds, setSplitPaneIds] = useAtom(splitPaneIdsAtom);
  const [keyboardFocusTerminalId, setKeyboardFocusTerminalId] = useAtom(splitKeyboardFocusAtom);
  const terminalCwds = useAtomValue(terminalCwdsAtomForChat);
  const setDisplayMode = useSetAtom(terminalDisplayModeAtom);

  // Theme detection for terminal background
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const palette = useAtomValue(activePaletteAtom);
  const terminalBg = useMemo(() => getTerminalTheme(isDark, palette).background, [isDark, palette]);

  const terminals = useMemo(() => allTerminals[chatId] || [], [allTerminals, chatId]);
  const activeTerminalId = useMemo(() => allActiveIds[chatId] || null, [allActiveIds, chatId]);
  const activeTerminal = useMemo(
    () => terminals.find((t) => t.id === activeTerminalId) || null,
    [terminals, activeTerminalId],
  );

  /** Resolved group membership (may exist while another tab is selected). */
  const splitPaneInstancesResolved = useMemo(
    () => resolveSplitPaneInstances(terminals, splitPaneIds),
    [terminals, splitPaneIds],
  );

  /** Strip is defined (tabs stay grouped under one badge even when another tab is active). */
  const splitGroupDefined = splitPaneInstancesResolved.length >= 2;

  /** Columns passed to TerminalContent — empty when a tab outside the group is active. */
  const splitPaneTerminals = useMemo(
    () =>
      getSplitPaneTerminalsForContent(splitPaneInstancesResolved, splitPaneIds, activeTerminalId),
    [splitPaneInstancesResolved, splitPaneIds, activeTerminalId],
  );

  const splitLayoutVisible = splitPaneTerminals.length >= 2;

  const terminalSplitEnabled = splitGroupDefined;

  /** Which terminal should own xterm keyboard focus (split-aware). */
  const terminalKeyboardTargetId = useMemo(() => {
    if (!splitLayoutVisible) return activeTerminalId;
    return keyboardFocusTerminalId ?? activeTerminalId;
  }, [splitLayoutVisible, keyboardFocusTerminalId, activeTerminalId]);

  const killMutation = trpc.terminal.kill.useMutation();

  // Refs to avoid callback recreation
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const activeTerminalIdRef = useRef(activeTerminalId);
  activeTerminalIdRef.current = activeTerminalId;
  const splitPaneIdsRef = useRef(splitPaneIds);
  splitPaneIdsRef.current = splitPaneIds;
  const keyboardFocusTerminalIdRef = useRef(keyboardFocusTerminalId);
  keyboardFocusTerminalIdRef.current = keyboardFocusTerminalId;

  /** Appends a session without selecting it (used when adding a split pane). */
  const appendTerminalWithoutActivating = useCallback(() => {
    const currentChatId = chatIdRef.current;
    const currentTerminals = terminalsRef.current;

    const id = generateTerminalId();
    const paneId = generatePaneId(currentChatId, id);
    const name = getNextTerminalName(currentTerminals);

    const newTerminal: TerminalInstance = {
      id,
      paneId,
      name,
      createdAt: Date.now(),
    };

    setAllTerminals((prev) => ({
      ...prev,
      [currentChatId]: [...(prev[currentChatId] || []), newTerminal],
    }));

    return newTerminal;
  }, [setAllTerminals]);

  const createTerminal = useCallback(() => {
    const currentChatId = chatIdRef.current;
    const currentTerminals = terminalsRef.current;

    const id = generateTerminalId();
    const paneId = generatePaneId(currentChatId, id);
    const name = getNextTerminalName(currentTerminals);

    const newTerminal: TerminalInstance = {
      id,
      paneId,
      name,
      createdAt: Date.now(),
    };

    setAllTerminals((prev) => ({
      ...prev,
      [currentChatId]: [...(prev[currentChatId] || []), newTerminal],
    }));

    setAllActiveIds((prev) => ({
      ...prev,
      [currentChatId]: id,
    }));
    setKeyboardFocusTerminalId(id);
  }, [setAllTerminals, setAllActiveIds, setKeyboardFocusTerminalId]);

  const selectTerminal = useCallback(
    (id: string) => {
      const currentChatId = chatIdRef.current;

      setAllActiveIds((prev) => ({
        ...prev,
        [currentChatId]: id,
      }));
      setKeyboardFocusTerminalId(id);
    },
    [setAllActiveIds, setKeyboardFocusTerminalId],
  );

  /** Adds a new PTY column after the focused pane (repeatable; never collapses to single-column). */
  const addSplitPane = useCallback(() => {
    const terms = terminalsRef.current;
    const active = activeTerminalIdRef.current;
    if (terms.length === 0 || !active) return;

    const newT = appendTerminalWithoutActivating();
    const order = splitPaneIdsRef.current;

    let next: string[];
    if (order.length === 0) {
      // Only the active tab's PTY is mounted — always split from it (not stale xterm focus).
      next = [active, newT.id];
    } else if (!order.includes(active)) {
      // Active tab is outside the current strip (e.g. new terminal tab) — start a fresh split here.
      next = [active, newT.id];
    } else {
      const focusForInsert = keyboardFocusTerminalIdRef.current ?? active;
      let idx = order.indexOf(focusForInsert);
      if (idx < 0) idx = order.indexOf(active);
      if (idx < 0) idx = order.length - 1;
      next = [...order.slice(0, idx + 1), newT.id, ...order.slice(idx + 1)];
    }
    setSplitPaneIds(next);
    setKeyboardFocusTerminalId(newT.id);
  }, [appendTerminalWithoutActivating, setSplitPaneIds, setKeyboardFocusTerminalId]);

  const closeTerminal = useCallback(
    (id: string) => {
      const currentChatId = chatIdRef.current;
      const currentTerminals = terminalsRef.current;
      const currentActiveId = activeTerminalIdRef.current;

      const terminal = currentTerminals.find((t) => t.id === id);
      if (!terminal) return;

      killMutation.mutate(
        { paneId: terminal.paneId },
        {
          onSuccess: () => {
            let nextForChat: TerminalInstance[] = [];
            setAllTerminals((prev) => {
              const list = prev[currentChatId] || [];
              nextForChat = list.filter((t) => t.id !== id);
              return { ...prev, [currentChatId]: nextForChat };
            });

            const prevOrder = splitPaneIdsRef.current;
            const nextOrder = prevOrder.filter((x) => x !== id);
            setSplitPaneIds(nextOrder.length >= 2 ? nextOrder : []);

            let newActiveId = currentActiveId;
            if (currentActiveId === id) {
              newActiveId = nextForChat[nextForChat.length - 1]?.id || null;
              setAllActiveIds((prev) => ({
                ...prev,
                [currentChatId]: newActiveId,
              }));
            }

            const kb = keyboardFocusTerminalIdRef.current;
            if (kb === id) {
              setKeyboardFocusTerminalId(
                newActiveId ?? nextForChat[nextForChat.length - 1]?.id ?? null,
              );
            }
          },
          onError: (err) => {
            toast.error(
              `Failed to close terminal: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        },
      );
    },
    [setAllTerminals, setAllActiveIds, killMutation, setSplitPaneIds, setKeyboardFocusTerminalId],
  );

  const renameTerminal = useCallback(
    (id: string, name: string) => {
      const currentChatId = chatIdRef.current;
      setAllTerminals((prev) => ({
        ...prev,
        [currentChatId]: (prev[currentChatId] || []).map((t) => (t.id === id ? { ...t, name } : t)),
      }));
    },
    [setAllTerminals],
  );

  const closeSplitGroup = useCallback(() => {
    const order = splitPaneIdsRef.current;
    if (order.length < 2) return;

    const currentChatId = chatIdRef.current;
    const currentTerminals = terminalsRef.current;

    void (async () => {
      const { succeededIds, errors } = await killTerminalPanesByIds(
        killMutation.mutateAsync,
        currentTerminals,
        order,
      );
      toastKillFailures(errors, 'Failed to close split group');

      if (succeededIds.length === 0) return;

      const killed = new Set(succeededIds);
      const newTerminals = currentTerminals.filter((t) => !killed.has(t.id));
      setAllTerminals((prev) => ({
        ...prev,
        [currentChatId]: newTerminals,
      }));

      const nextOrder = order.filter((tid) => !killed.has(tid));
      setSplitPaneIds(nextOrder.length >= 2 ? nextOrder : []);
      const newActive = newTerminals.at(-1)?.id ?? null;
      setAllActiveIds((prev) => ({
        ...prev,
        [currentChatId]: newActive,
      }));
      setKeyboardFocusTerminalId(newActive);
    })();
  }, [setAllTerminals, killMutation, setSplitPaneIds, setAllActiveIds, setKeyboardFocusTerminalId]);

  const closeOtherTerminals = useCallback(
    (id: string) => {
      const currentChatId = chatIdRef.current;
      const currentTerminals = terminalsRef.current;
      const order = splitPaneIdsRef.current;

      const keepGroup =
        order.length >= 2 && id === order[0] ? new Set<string>(order) : new Set<string>([id]);

      const toKill = currentTerminals.filter((terminal) => !keepGroup.has(terminal.id));

      void (async () => {
        const idsToKillOrdered = toKill.map((t) => t.id);
        const { succeededIds, errors } = await killTerminalPanesByIds(
          killMutation.mutateAsync,
          currentTerminals,
          idsToKillOrdered,
        );
        toastKillFailures(errors, 'Failed to close other terminals');

        if (succeededIds.length === 0) return;

        const killed = new Set(succeededIds);
        const remainingTerminals = currentTerminals.filter(
          (t) => keepGroup.has(t.id) || !killed.has(t.id),
        );
        setAllTerminals((prev) => ({
          ...prev,
          [currentChatId]: remainingTerminals,
        }));

        const keptPrimary = order.length >= 2 && id === order[0] ? order[0] : id;
        setAllActiveIds((prev) => ({
          ...prev,
          [currentChatId]: keptPrimary,
        }));

        if (order.length >= 2 && id === order[0]) {
          setSplitPaneIds([...order]);
        } else {
          setSplitPaneIds([]);
        }
        setKeyboardFocusTerminalId(keptPrimary);
      })();
    },
    [setAllTerminals, setAllActiveIds, killMutation, setSplitPaneIds, setKeyboardFocusTerminalId],
  );

  const closeTerminalsToRight = useCallback(
    (id: string) => {
      const currentChatId = chatIdRef.current;
      const currentTerminals = terminalsRef.current;
      const paneOrder = splitPaneIdsRef.current;

      const visible = getVisibleTerminalTabsForStrip(currentTerminals, paneOrder);
      const vidx = visible.findIndex((t) => t.id === id);
      if (vidx === -1) return;

      const toCloseVisible = visible.slice(vidx + 1);
      const idsToKill = new Set<string>();
      for (const t of toCloseVisible) {
        if (paneOrder.length >= 2 && t.id === paneOrder[0]) {
          for (const pid of paneOrder) idsToKill.add(pid);
        } else {
          idsToKill.add(t.id);
        }
      }
      if (idsToKill.size === 0) return;

      const currentActiveId = activeTerminalIdRef.current;

      void (async () => {
        const idsOrdered = Array.from(idsToKill);
        const { succeededIds, errors } = await killTerminalPanesByIds(
          killMutation.mutateAsync,
          currentTerminals,
          idsOrdered,
        );
        toastKillFailures(errors, 'Failed to close terminals');

        if (succeededIds.length === 0) return;

        const killed = new Set(succeededIds);
        const remainingTerminals = currentTerminals.filter((t) => !killed.has(t.id));
        setAllTerminals((prev) => ({
          ...prev,
          [currentChatId]: remainingTerminals,
        }));

        let newActiveId = currentActiveId;
        if (currentActiveId && killed.has(currentActiveId)) {
          newActiveId = remainingTerminals.at(-1)?.id ?? null;
          setAllActiveIds((prev) => ({
            ...prev,
            [currentChatId]: newActiveId,
          }));
        }

        const nextPaneIds = paneOrder.filter((pid) => !killed.has(pid));
        setSplitPaneIds(nextPaneIds.length >= 2 ? nextPaneIds : []);

        const kb = keyboardFocusTerminalIdRef.current;
        if (kb && killed.has(kb)) {
          setKeyboardFocusTerminalId(newActiveId ?? remainingTerminals.at(-1)?.id ?? null);
        }
      })();
    },
    [setAllTerminals, setAllActiveIds, killMutation, setSplitPaneIds, setKeyboardFocusTerminalId],
  );

  const closePanel = useCallback(() => {
    setIsOpen(false);
  }, [setIsOpen]);

  // Delay rendering until animation completes
  const [canRenderTerminal, setCanRenderTerminal] = useState(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setCanRenderTerminal(false);
      const timer = setTimeout(() => setCanRenderTerminal(true), 0);
      wasOpenRef.current = true;
      return () => clearTimeout(timer);
    } else if (!isOpen) {
      wasOpenRef.current = false;
      setCanRenderTerminal(false);
    }
  }, [isOpen]);

  // Auto-create first terminal when opened and none exist.
  // Only one panel should run this to avoid a race where both create a terminal.
  useEffect(() => {
    if (skipAutoCreate) return;
    if (isOpen && terminals.length === 0) {
      createTerminal();
    }
  }, [isOpen, terminals.length, createTerminal, skipAutoCreate]);

  // Drop stale split ids (killed sessions) or collapse invalid strip state.
  useEffect(() => {
    const next = normalizeSplitPaneIds(splitPaneIds, terminals);
    if (next.join(',') !== splitPaneIds.join(',')) {
      setSplitPaneIds(next);
    }
  }, [splitPaneIds, terminals, setSplitPaneIds]);

  // When not viewing the split layout, keep keyboard focus aligned with the selected tab.
  useEffect(() => {
    if (splitLayoutVisible) return;
    setKeyboardFocusTerminalId(activeTerminalId);
  }, [splitLayoutVisible, activeTerminalId, setKeyboardFocusTerminalId]);

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  // Screen reader announcement cleanup
  const srAnnouncementTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    return () => clearTimeout(srAnnouncementTimerRef.current);
  }, []);

  // Read split view on-demand (avoid subscribing to avoid re-renders on resize/reorder)
  const store = useStore();

  // Terminal keyboard shortcuts — in split view, only the active pane responds
  useEffect(() => {
    if (skipKeyboardShortcut) return;

    const isActivePane = () => {
      const sv = store.get(splitViewAtom);
      return sv.chatIds.length < 2 || sv.chatIds[sv.activePaneIndex] === chatId;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.code !== 'KeyJ') return;
      if (!isActivePane()) return;

      // Cmd+Shift+J — toggle terminal position (sidebar ↔ bottom)
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const current = store.get(terminalDisplayModeAtom);
        const next = current === 'side-peek' ? 'bottom' : 'side-peek';
        runChatShortcutAction(store, true, () => setDisplayMode(next));

        // Announce to screen readers
        const announcement = document.createElement('div');
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.className = 'sr-only';
        announcement.textContent = `Terminal moved to ${next === 'side-peek' ? 'sidebar' : 'bottom panel'}`;
        document.body.appendChild(announcement);
        srAnnouncementTimerRef.current = setTimeout(() => announcement.remove(), 1000);
        return;
      }

      // Cmd+J — toggle terminal open/close
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = isOpenRef.current;
      runChatShortcutAction(store, true, () => setIsOpen(!wasOpen));

      // When closing the terminal, auto-focus the chat input
      if (wasOpen) {
        requestAnimationFrame(() => {
          const sv = store.get(splitViewAtom);
          const isSplit = sv.chatIds.length >= 2;
          const container = isSplit
            ? document.querySelector(`[data-pane-index="${sv.activePaneIndex}"]`)
            : document;
          focusChatInput(container);
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [setIsOpen, setDisplayMode, skipKeyboardShortcut, chatId, store]);

  const setTerminalKeyboardFocus = useCallback(
    (terminalId: string | null) => {
      setKeyboardFocusTerminalId(terminalId);
    },
    [setKeyboardFocusTerminalId],
  );

  return {
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
    splitPaneTerminalIds: splitPaneIds,
    keyboardFocusTerminalId,
    terminalKeyboardTargetId,
    setTerminalKeyboardFocus,
  };
}
