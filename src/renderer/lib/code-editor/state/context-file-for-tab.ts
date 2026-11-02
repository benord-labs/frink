import { getFullPath } from '../files/model-path';
import type { OpenFile } from './atoms';

type ContextTab = Pick<
  OpenFile,
  'path' | 'name' | 'projectPath' | 'sourceChatId' | 'isOtherProject'
>;

/** The agent reads a relative path against its own folder, so it needs the full path for a file
 *  from another project, or for a tab written into another split pane's chat. */
function needsFullPath(
  file: ContextTab,
  targetChatId: string | null | undefined,
  isSplit: boolean,
): boolean {
  if (file.isOtherProject) return true;
  return isSplit && Boolean(file.sourceChatId) && targetChatId !== file.sourceChatId;
}

/** The open file `targetChatId`'s next message names. Other tabs keep the path as opened, so
 *  single-view chat switches keep today's relative path (and its mention dedupe). */
export function contextPathForTab(
  file: ContextTab,
  targetChatId: string | null | undefined,
  isSplit: boolean,
): { name: string; path: string } {
  const path = needsFullPath(file, targetChatId, isSplit)
    ? getFullPath(file.projectPath, file.path)
    : file.path;
  return { name: file.name, path };
}

/** The file a code selection names: by the same rule, the full path or just the file name. */
export function selectionFileNameForTab(
  file: ContextTab,
  targetChatId: string | null | undefined,
  isSplit: boolean,
): string {
  return needsFullPath(file, targetChatId, isSplit)
    ? getFullPath(file.projectPath, file.path)
    : file.name;
}
