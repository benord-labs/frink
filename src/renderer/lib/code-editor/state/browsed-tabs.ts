import { atom } from 'jotai';
import { isSameFolder } from '../../../../shared/lib/path-normalization';
import {
  activeFilePathAtom,
  codeEditorOpenAtom,
  fileKey,
  type OpenFile,
  openFilesAtom,
  revokePdfBlobIfPresent,
} from './atoms';

type SettleBrowsedTabsInput = {
  /** The chat now shown in single view */
  chatId: string;
  /** The folder that chat works in (its worktree, else its project); null for a general chat */
  mainProjectPath: string | null;
  /** Other projects in that chat's file tree, whose tabs it keeps */
  keepProjectPaths: string[];
};

type SettledTabs = { files: OpenFile[]; closed: OpenFile[] };

/**
 * Which of another project's tabs stay when single view shows `chatId`. A tab from the chat's own
 * project becomes an ordinary tab of that chat; one opened from this chat, or from a project in its
 * tree, stays (moved to this chat); an unsaved one stays; every other one closes. Ordinary tabs
 * are never touched.
 */
export function settleBrowsedTabs(
  files: OpenFile[],
  { chatId, mainProjectPath, keepProjectPaths }: SettleBrowsedTabsInput,
): SettledTabs {
  const kept: OpenFile[] = [];
  const closed: OpenFile[] = [];
  for (const file of files) {
    if (!file.isOtherProject) {
      kept.push(file);
    } else if (isSameFolder(file.projectPath, mainProjectPath)) {
      const { isOtherProject: _, ...ordinary } = file;
      kept.push({ ...ordinary, sourceChatId: chatId });
    } else if (file.isDirty) {
      kept.push(file);
    } else if (
      file.sourceChatId === chatId ||
      keepProjectPaths.some((folder) => isSameFolder(file.projectPath, folder))
    ) {
      kept.push(file.sourceChatId === chatId ? file : { ...file, sourceChatId: chatId });
    } else {
      closed.push(file);
    }
  }
  return { files: kept, closed };
}

/** Applies settleBrowsedTabs to the open tabs; writes nothing when no tab changes. */
export const settleBrowsedTabsAtom = atom(null, (get, set, input: SettleBrowsedTabsInput) => {
  const files = get(openFilesAtom);
  const { files: next, closed } = settleBrowsedTabs(files, input);
  if (closed.length === 0 && next.every((file, i) => file === files[i])) return;

  closed.forEach(revokePdfBlobIfPresent);
  set(openFilesAtom, next);

  const activeKey = get(activeFilePathAtom);
  if (closed.some((f) => fileKey(f.path, f.projectPath) === activeKey)) {
    const first = next[0];
    set(activeFilePathAtom, first ? fileKey(first.path, first.projectPath) : null);
  }
  if (next.length === 0) set(codeEditorOpenAtom, false);
});
