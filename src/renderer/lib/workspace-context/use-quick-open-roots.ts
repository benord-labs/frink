/**
 * The folders quick open (Search files) searches, and how a file it finds opens.
 */
import { useSetAtom } from 'jotai';
import { normalizePathForComparison } from '../../../shared/lib/path-normalization';
import { openFileAtom } from '@/lib/code-editor/state';
import { browsedFileOpenInput } from './use-open-browsed-file';
import { useTreeProjects } from './use-tree-projects';

/** A folder quick open searches: the chat's own (`isChat`), or a project linked to the chat */
export type QuickOpenRoot = { path: string; name: string; isChat: boolean };

type UseQuickOpenRootsInput = {
  /** Split view: quick open follows the active pane's chat, and its folder. The chat is null for a
   *  pane holding a new-chat form or nothing yet, which has no folder to search. */
  pane?: { index: number; chatId: string | null };
  /** Single view: the selected chat and the folder searched for it, with its worktree if any */
  single: { chatId: string | null; path: string | undefined; worktreePath: string | undefined };
};

/**
 * The chat's own folder first, then each project linked to it, in link order; a linked folder
 * known to be gone is left out. A file from the chat's folder opens as its own tab; one from a
 * linked project opens as a preview tab of the chat.
 */
export function useQuickOpenRoots({ pane, single }: UseQuickOpenRootsInput) {
  const chatId = pane ? pane.chatId : single.chatId;
  const { main, readable } = useTreeProjects(chatId);
  const openFile = useSetAtom(openFileAtom);
  // A split pane's chat works in its own project's folder, or its worktree.
  const path = pane ? main?.workingPath : single.path;
  const isWorktree = pane
    ? !!main &&
      normalizePathForComparison(main.workingPath) !== normalizePathForComparison(main.path)
    : !!single.worktreePath;
  const roots: QuickOpenRoot[] = path
    ? [
        { path, name: main?.name ?? '', isChat: true },
        ...readable.map((project) => ({ path: project.path, name: project.name, isChat: false })),
      ]
    : [];
  const paneIndex = pane?.index;
  const open = (filePath: string, root: QuickOpenRoot) =>
    openFile(
      // Another project's root is in the tree only for a chat, so `chatId` is set for one.
      !root.isChat && chatId
        ? browsedFileOpenInput(filePath, { projectPath: root.path, chatId, paneIndex })
        : {
            path: filePath,
            name: filePath.split('/').pop() ?? filePath,
            projectPath: root.path,
            sourcePaneIndex: paneIndex,
            sourceChatId: chatId ?? undefined,
            isWorktreeContext: isWorktree,
            intent: 'preview',
          },
    );
  return { roots, open };
}
