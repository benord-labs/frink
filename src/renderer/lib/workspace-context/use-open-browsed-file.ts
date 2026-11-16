/**
 * How a file of another project in a chat's file tree opens in the editor, for every part of the
 * tree that shows that project, and for quick open.
 */
import { useSetAtom } from 'jotai';
import { openFileAtom } from '@/lib/code-editor/state';

type BrowsedFileSource = {
  /** The other project's folder */
  projectPath: string;
  /** The chat whose tree this is; a file opens as that chat's tab */
  chatId: string;
  /** The split-view pane the tree sits in */
  paneIndex?: number;
};

/**
 * The tab a file of another project in `chatId`'s tree opens as: a preview tied to that chat. A
 * browsed file never becomes the chat's context file: it isn't in the chat's own project.
 */
export function browsedFileOpenInput(
  path: string,
  { projectPath, chatId, paneIndex }: BrowsedFileSource,
) {
  return {
    path,
    name: path.split('/').pop() ?? path,
    projectPath,
    isOtherProject: true,
    isWorktreeContext: false,
    sourceChatId: chatId,
    sourcePaneIndex: paneIndex,
    intent: 'preview' as const,
  };
}

/** Opens a file of another project in `chatId`'s tree, as browsedFileOpenInput describes. */
export function useOpenBrowsedFile(source: BrowsedFileSource): (path: string) => void {
  const openFile = useSetAtom(openFileAtom);
  return (path) => openFile(browsedFileOpenInput(path, source));
}
