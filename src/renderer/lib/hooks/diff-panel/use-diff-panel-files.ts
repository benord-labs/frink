import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo } from 'react';
import {
  filteredDiffFilesAtomFamily,
  filteredSubChatIdAtomFamily,
  subChatFilesAtom,
} from '../../atoms';
import { useGitWatcher } from '../use-file-change-listener';
import { useChatDiff } from './use-chat-diff';
import {
  filterDiffFilesByPath,
  getDiffPanelNotice,
  parseRenderableDiffFiles,
  resolveDiffScopePaths,
} from '../../utils/diff/diff-code-view-items';

/** The chat's diff, parsed for CodeView and narrowed by any sub-chat filter. `watchPath` makes
 * the panel refresh itself on repo changes when no chat view is mounted to do it. */
export function useDiffPanelFiles(chatId: string, watchPath: string | null) {
  const { files: parsedFileDiffs, diffStats, error, refresh } = useChatDiff(chatId, true);
  useGitWatcher(watchPath, refresh);
  const [filteredPaths, setFilteredPaths] = useAtom(filteredDiffFilesAtomFamily(chatId));
  const [filteredSubChatId, setFilteredSubChatId] = useAtom(filteredSubChatIdAtomFamily(chatId));
  const subChatFiles = useAtomValue(subChatFilesAtom);

  const clearFilter = useCallback(() => {
    setFilteredPaths(null);
    setFilteredSubChatId(null);
  }, [setFilteredPaths, setFilteredSubChatId]);
  // A sub-chat's filter lasts as long as the panel is open.
  useEffect(() => clearFilter, [clearFilter]);

  const { renderable, unrenderableCount } = useMemo(
    () => parseRenderableDiffFiles(parsedFileDiffs ?? []),
    [parsedFileDiffs],
  );
  const scopePaths = useMemo(
    () => resolveDiffScopePaths(filteredPaths, subChatFiles.get(filteredSubChatId ?? '')),
    [filteredPaths, filteredSubChatId, subChatFiles],
  );
  const visible = useMemo(
    () => filterDiffFilesByPath(renderable, scopePaths),
    [renderable, scopePaths],
  );
  const visibleKeys = useMemo(() => visible.map((file) => file.key), [visible]);
  const hasChanges = renderable.length + unrenderableCount > 0;

  return {
    visible,
    visibleKeys,
    // Every changed file, including binary or unreadable ones the viewer can't render
    totalCount: renderable.length + unrenderableCount,
    unrenderableCount,
    diffStats,
    hasChanges,
    isFiltered: scopePaths !== null,
    clearFilter,
    notice: getDiffPanelNotice({
      isLoading: diffStats.isLoading,
      error,
      hasChanges,
    }),
  };
}
