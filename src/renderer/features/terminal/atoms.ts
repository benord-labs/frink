import { atom } from 'jotai';
import { atomFamily, atomWithStorage, selectAtom } from 'jotai/utils';
import { atomWithWindowStorage } from '@/lib/window-storage';
import type { TerminalInstance } from './types';

// ============================================================================
// Terminal Display Mode
// ============================================================================

/** Terminal can render as a right sidebar or a bottom panel */
export type TerminalDisplayMode = 'side-peek' | 'bottom';

/** Per-window display mode — each Electron window picks its own layout */
export const terminalDisplayModeAtom = atomWithWindowStorage<TerminalDisplayMode>(
  'terminal-display-mode',
  'side-peek',
  { getOnInit: true },
);

/** Bottom panel height — shared across windows for consistent sizing */
export const terminalBottomHeightAtom = atomWithStorage<number>(
  'terminal-bottom-height',
  300,
  undefined,
  { getOnInit: true },
);

/** Right-sidebar width — shared across windows for consistent sizing */
export const terminalSidebarWidthAtom = atomWithStorage<number>(
  'terminal-sidebar-width',
  500,
  undefined,
  { getOnInit: true },
);

// Storage atom for persisting per-chat terminal sidebar state
const terminalSidebarOpenStorageAtom = atomWithStorage<Record<string, boolean>>(
  'terminal-sidebar-open-by-chat',
  {},
  undefined,
  { getOnInit: true },
);

// Per-chat terminal sidebar open state (like diffSidebarOpenAtomFamily)
export const terminalSidebarOpenAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(terminalSidebarOpenStorageAtom)[chatId] ?? false,
    (get, set, isOpen: boolean) => {
      const current = get(terminalSidebarOpenStorageAtom);
      set(terminalSidebarOpenStorageAtom, { ...current, [chatId]: isOpen });
    },
  ),
);

// Terminal cwd tracking - maps paneId to current working directory
export const terminalCwdAtom = atomWithStorage<Record<string, string>>(
  'terminal-cwds',
  {},
  undefined,
  { getOnInit: true },
);

// ============================================================================
// Multi-Terminal State Management
// ============================================================================

/**
 * Map of chatId -> terminal instances.
 * Each chat can have multiple terminal instances.
 */
export const terminalsAtom = atomWithStorage<Record<string, TerminalInstance[]>>(
  'terminals-by-chat',
  {},
  undefined,
  { getOnInit: true },
);

function terminalCwdsRecordEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

/** Bundle for selectAtom — narrows cwd updates to this chat's pane ids only. */
const terminalCwdsBundleAtomFamily = atomFamily((chatId: string) =>
  atom((get) => ({
    terminals: get(terminalsAtom)[chatId] || [],
    allCwds: get(terminalCwdAtom),
  })),
);

/** Per-chat cwd map: only re-renders consumers when this chat's pane paths change. */
export const terminalCwdsForChatAtomFamily = atomFamily((chatId: string) =>
  selectAtom(
    terminalCwdsBundleAtomFamily(chatId),
    ({ terminals, allCwds }) => {
      const out: Record<string, string> = {};
      for (const t of terminals) {
        const v = allCwds[t.paneId];
        if (v !== undefined) out[t.paneId] = v;
      }
      return out;
    },
    terminalCwdsRecordEqual,
  ),
);

/**
 * Map of chatId -> active terminal id.
 * Tracks which terminal is currently active for each chat.
 */
export const activeTerminalIdAtom = atomWithStorage<Record<string, string | null>>(
  'active-terminal-by-chat',
  {},
  undefined,
  { getOnInit: true },
);

// ---------------------------------------------------------------------------
// Horizontal split: ordered terminal ids (left-to-right). Empty = single pane.
// ---------------------------------------------------------------------------

const terminalSplitPaneIdsStorageAtom = atomWithStorage<Record<string, string[]>>(
  'terminal-split-pane-ids-by-chat',
  {},
  undefined,
  { getOnInit: true },
);

/** Ordered pane session ids when two or more columns are visible. */
export const terminalSplitPaneIdsAtomFamily = atomFamily((chatId: string) =>
  atom(
    (get) => get(terminalSplitPaneIdsStorageAtom)[chatId] ?? [],
    (get, set, paneIds: string[]) => {
      const current = get(terminalSplitPaneIdsStorageAtom);
      set(terminalSplitPaneIdsStorageAtom, { ...current, [chatId]: paneIds });
    },
  ),
);

/**
 * Which terminal id receives keyboard input in split mode.
 * Not persisted — reset when split toggles or tab focus changes.
 */
export const terminalSplitKeyboardFocusIdAtomFamily = atomFamily((_chatId: string) =>
  atom<string | null>(null),
);
