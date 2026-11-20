import { atom } from 'jotai';
import type { LeaveReason } from '../../../../shared/leave-reason';
import {
  activeFilePathAtom,
  closeFileAtom,
  codeEditorOpenAtom,
  fileKey,
  openFilesAtom,
  revokePdfBlobIfPresent,
} from './atoms';
import { keepUnsavedTab, tabsChanged } from './unsaved-tab';

/** Keys of unsaved tabs waiting on a Save / Don't save / Cancel answer; null when no prompt is open. */
export const pendingCloseKeysAtom = atom<string[] | null>(null);

/**
 * A close the user asked for: clean tabs close now, unsaved ones wait on the prompt, which the
 * editor panel shows. Ignored while a prompt is open, so a second Cmd+W cannot close another tab.
 */
export const requestCloseFilesAtom = atom(null, (get, set, keys: string[]) => {
  if (get(pendingCloseKeysAtom)) return;
  const dirty = new Set(
    get(openFilesAtom)
      .filter((f) => f.isDirty)
      .map((f) => fileKey(f.path, f.projectPath)),
  );
  for (const key of keys) {
    if (!dirty.has(key)) set(closeFileAtom, key);
  }
  const unsaved = keys.filter((key) => dirty.has(key));
  if (unsaved.length === 0) return;
  set(pendingCloseKeysAtom, unsaved);
  set(codeEditorOpenAtom, true);
});

/** Where focus goes once the unsaved-changes prompt closes: the editor panel registers its editor. */
export const promptReturnFocusAtom = atom<{ focus: () => void } | null>(null);

/** Why the window is waiting on the prompt (quit, close, reload, update); null for a tab close. */
export const pendingLeaveAtom = atom<LeaveReason | null>(null);

/**
 * The window wants to go: the prompt covers every unsaved tab, replacing a tab-close prompt.
 * Returns false when nothing is unsaved, so the caller lets the window go at once.
 */
export const requestLeaveAtom = atom(null, (get, set, reason: LeaveReason): boolean => {
  const unsaved = get(openFilesAtom)
    .filter((f) => f.isDirty)
    .map((f) => fileKey(f.path, f.projectPath));
  if (unsaved.length === 0) return false;
  set(pendingLeaveAtom, reason);
  set(pendingCloseKeysAtom, unsaved);
  set(codeEditorOpenAtom, true);
  return true;
});

/** Answers the pending leave once; later calls (e.g. an unmount after Save) do nothing. */
export const settleLeaveAtom = atom(null, (get, set, outcome: 'confirm' | 'cancel') => {
  if (get(pendingLeaveAtom) === null) return;
  set(pendingLeaveAtom, null);
  if (outcome === 'confirm') window.desktopApi?.confirmLeave();
  else window.desktopApi?.cancelLeave();
});

export const requestCloseAllFilesAtom = atom(null, (get, set) => {
  set(
    requestCloseFilesAtom,
    get(openFilesAtom).map((f) => fileKey(f.path, f.projectPath)),
  );
});

/** Closes a closed pane's saved tabs unless a remaining pane shares their project; unsaved tabs stay. */
export const closePaneTabsAtom = atom(
  null,
  (
    get,
    set,
    {
      closedPaneIndex,
      remainingProjectPaths,
    }: { closedPaneIndex: number; remainingProjectPaths: string[] },
  ) => {
    const files = get(openFilesAtom);
    if (files.length === 0) return;

    const remainingProjects = new Set(remainingProjectPaths);

    const kept = files.flatMap((f) => {
      if (f.sourcePaneIndex !== closedPaneIndex) return [f];
      if (f.projectPath !== undefined && remainingProjects.has(f.projectPath)) return [f];
      return f.isDirty ? [keepUnsavedTab(f)] : [];
    });

    // Shift sourcePaneIndex on remaining files: indices above the removed pane move down
    const shifted = kept.map((f) => {
      if (f.sourcePaneIndex !== undefined && f.sourcePaneIndex > closedPaneIndex) {
        return { ...f, sourcePaneIndex: f.sourcePaneIndex - 1 };
      }
      return f;
    });

    if (!tabsChanged(files, shifted)) return;

    const keptKeys = new Set(kept.map((f) => fileKey(f.path, f.projectPath)));
    files.forEach((f) => {
      if (!keptKeys.has(fileKey(f.path, f.projectPath))) revokePdfBlobIfPresent(f);
    });

    set(openFilesAtom, shifted);

    const activeKey = get(activeFilePathAtom);
    const activeStillOpen = kept.some((f) => fileKey(f.path, f.projectPath) === activeKey);
    if (!activeStillOpen) {
      const first = kept[0];
      set(activeFilePathAtom, first ? fileKey(first.path, first.projectPath) : null);
      if (kept.length === 0) {
        set(codeEditorOpenAtom, false);
      }
    }
  },
);
