import { useAtomValue } from 'jotai';
import type { ReactElement } from 'react';
import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { asEntryOfParent } from '@/lib/workspace-context/project-paths';
import { useOpenBrowsedFile } from '@/lib/workspace-context/use-open-browsed-file';
import { contentSearchOptionsAtom } from '../../atoms';
import { ContentSearchResults } from '../../ContentSearchResults';
import { FILE_TREE_REFRESH_EVENT } from '../../refresh-trigger';
import { useContentSearch } from '../../use-content-search-tab';
import { openContentSearchMatchInEditor } from '../../utils/content-search-actions';
import { createMatchHighlighter } from '../../utils/highlight-match';
import { FOCUS_REFRESH_MS, LINKED_BADGE, SEARCH_SECTION_CLASS } from '../constants';
import { RootHeading } from '../ProjectRootRow';

type Props = {
  /** The linked project, searched in its registered folder; `missing` when that folder is gone */
  project: { id: string; name: string; path: string; missing?: boolean };
  /** The chat whose tree this is; a match opens as that chat's tab */
  chatId: string;
  /** The split-view pane the tree sits in */
  paneIndex?: number;
  /** The Search tab's query, already debounced */
  query: string;
  /** The typed query has moved on from `query` and isn't searched yet */
  isStale?: boolean;
};

/**
 * A linked project's matches for the Search tab's query, under that project's name, with the same
 * search options as the chat's own results. A match opens the file at its line as a browsed tab.
 * A folder known to be missing says so, as the tree does, and is not searched.
 * No git watcher runs for the project, so the matches are read again after one of its files is
 * saved, and on window focus at most every 30 seconds.
 */
export function ExtraProjectContentSearch({
  project,
  chatId,
  paneIndex,
  query,
  isStale,
}: Props): ReactElement {
  const options = useAtomValue(contentSearchOptionsAtom);
  const utils = trpc.useUtils();
  const lastReadAt = useRef(0);
  const openInEditor = useOpenBrowsedFile({ projectPath: project.path, chatId, paneIndex });
  // A folder known to be gone is not searched at all.
  const search = useContentSearch({
    projectPath: project.path,
    query,
    options,
    enabled: !project.missing,
  });
  const { invalidRegex, isLoading } = search;
  const matches = project.missing ? [] : search.matches;
  const renderLine = useMemo(() => createMatchHighlighter(query, options), [query, options]);

  // The search reads a missing folder as one with no matches, so no matches asks the disk, and
  // the section waits for that answer before it says nothing matched.
  const folderEntry = asEntryOfParent(project.path);
  const noMatches =
    !project.missing && query.trim() !== '' && !isLoading && !invalidRegex && matches.length === 0;
  const folderType = trpc.files.entryType.useQuery(folderEntry, { enabled: noMatches });
  const cantOpen = noMatches && folderType.isSuccess && folderType.data !== 'folder';

  const refresh = () => {
    lastReadAt.current = Date.now();
    void utils.files.searchContent.invalidate({ projectPath: project.path });
    void utils.files.entryType.invalidate(folderEntry);
  };
  const onWindowFocus = useEffectEvent(() => {
    if (Date.now() - lastReadAt.current >= FOCUS_REFRESH_MS) refresh();
  });
  const onFileTreeRefresh = useEffectEvent((event: Event) => {
    // SAFETY: only FILE_TREE_REFRESH_EVENT dispatches carry this detail shape.
    const { projectPath } = (event as CustomEvent<{ projectPath: string }>).detail;
    if (projectPath === project.path) refresh();
  });
  // The section searches as it shows, so the first focus counts from then.
  useEffect(() => {
    lastReadAt.current = Date.now();
    const handleFocus = () => onWindowFocus();
    const handleRefresh = (event: Event) => onFileTreeRefresh(event);
    window.addEventListener('focus', handleFocus);
    window.addEventListener(FILE_TREE_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(FILE_TREE_REFRESH_EVENT, handleRefresh);
    };
  }, []);

  return (
    <ContentSearchResults
      heading={<RootHeading name={project.name} path={project.path} badge={LINKED_BADGE} />}
      className={SEARCH_SECTION_CLASS}
      isLoading={isLoading || (noMatches && folderType.isLoading)}
      isStale={isStale}
      query={query}
      invalidRegex={invalidRegex}
      matches={matches}
      emptyMessage={
        project.missing
          ? `Can't find ${project.name}'s folder.`
          : cantOpen
            ? `Can't open ${project.name}'s folder. It may have moved or been deleted.`
            : `No matches in ${project.name}.`
      }
      onSelectMatch={(relativePath, lineNumber, startColumn, endColumn) =>
        openContentSearchMatchInEditor(
          project.path,
          relativePath,
          lineNumber,
          startColumn,
          endColumn,
          openInEditor,
        )
      }
      renderLine={renderLine}
    />
  );
}
