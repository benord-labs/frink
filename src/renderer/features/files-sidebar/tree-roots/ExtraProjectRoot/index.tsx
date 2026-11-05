import { useSetAtom } from 'jotai';
import { Eye } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { openFileAtom } from '@/lib/code-editor/state';
import { trpc } from '@/lib/trpc';
import {
  normalizePathSlashes,
  trimTrailingSlashes,
} from '../../../../../shared/lib/path-normalization';
import { FILES_FETCH_LIMIT, READ_ONLY_FILE_TREE_KEY_SHORTCUTS } from '../../constants';
import { FileTree } from '../../FileTree';
import { ReadOnlyContext } from '../../FileTree/ReadOnlyContext';
import { RefreshContext } from '../../FileTree/RefreshContext';
import { useMultiSelect } from '../../FileTree/use-multi-select';
import { LoadingState } from '../../LoadingState';
import { useFileTreeNavigation } from '../../use-file-tree-navigation';
import { useFileTreeNodes } from '../../utils/build-file-tree';
import { getVisiblePaths } from '../../utils/get-visible-paths';
import { createMetaLookupFromDOM } from '../../utils/meta-lookup-from-dom';
import { ProjectRootRow } from '../ProjectRootRow';

/** Window focus re-reads the files at most this often. */
const FOCUS_REFRESH_MS = 30_000;
/** The branch is re-read at most this often: reading it lists every branch and worktree. */
const BRANCH_STALE_MS = 60_000;
const BROWSING_BADGE = { label: 'Browsing', icon: Eye, tone: 'browse' } as const;
const doNothing = () => {};

/** A folder as an entry of the folder that holds it, which is how files.entryType can stat it. */
function asEntryOfParent(folderPath: string) {
  const folder = trimTrailingSlashes(normalizePathSlashes(folderPath));
  const cut = folder.lastIndexOf('/') + 1;
  return { projectPath: folder.slice(0, cut), relativePath: folder.slice(cut) };
}

type Props = {
  /** The other project, shown from its registered folder */
  project: { id: string; name: string; path: string };
  /** The chat whose tree this is; its files open as that chat's tabs */
  chatId: string;
  /** The split-view pane the tree sits in */
  paneIndex?: number;
  /** The tree's name filter, already debounced; empty lists the folder */
  searchQuery?: string;
  /** Gives the tree its own drag and drop context, for a host that has no shared one */
  manageDnd?: boolean;
  onRemove: () => void;
};

/**
 * Another project's files under their own root row in a chat's file tree. Nothing here can be
 * created, renamed, moved, pasted or deleted, and no git watcher runs: the files are re-read when
 * the root opens, and on window focus at most every 30 seconds.
 */
export function ExtraProjectRoot({
  project,
  chatId,
  paneIndex,
  searchQuery = '',
  manageDnd = false,
  onRemove,
}: Props): ReactElement {
  const [expanded, setExpanded] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const lastReadAt = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const utils = trpc.useUtils();
  const openFile = useSetAtom(openFileAtom);
  const selection = useMultiSelect();
  const isSearching = searchQuery.length > 0;
  const folderEntry = asEntryOfParent(project.path);

  const listing = trpc.files.listDirectory.useQuery(
    { projectPath: project.path, relativePath: '' },
    { enabled: expanded && !isSearching },
  );
  const search = trpc.files.search.useQuery(
    { projectPath: project.path, query: searchQuery, limit: FILES_FETCH_LIMIT },
    { enabled: expanded && isSearching },
  );
  const shown = isSearching ? search : listing;
  // The listing and the search read a missing folder as an empty one, so an empty result asks
  // the disk, and the tree waits for that answer before it calls the folder empty.
  const isEmpty = shown.data?.length === 0;
  const folderType = trpc.files.entryType.useQuery(folderEntry, { enabled: expanded && isEmpty });
  const cantOpen =
    shown.isError || (isEmpty && folderType.isSuccess && folderType.data !== 'folder');
  const isLoading = shown.isLoading || (isEmpty && folderType.isLoading);
  // A folder that isn't a git repository fails here and shows no branch.
  const branchInput = { worktreePath: project.path };
  const branch = trpc.changes.getBranches.useQuery(branchInput, {
    staleTime: BRANCH_STALE_MS,
  }).data?.current;
  const { nodes } = useFileTreeNodes({
    rootContents: listing.data ?? [],
    searchResults: search.data ?? [],
    isSearching,
    showModifiedOnly: false,
  });

  // Re-reads this project's listing or search, every folder open in it, and its branch once that
  // is a minute old.
  const refresh = () => {
    lastReadAt.current = Date.now();
    void utils.files.listDirectory.invalidate({ projectPath: project.path });
    void utils.files.search.invalidate({ projectPath: project.path });
    void utils.files.entryType.invalidate(folderEntry);
    void utils.changes.getBranches.invalidate(branchInput, { stale: true });
    setRefreshTrigger((count) => count + 1);
  };
  const onWindowFocus = useEffectEvent(() => {
    if (Date.now() - lastReadAt.current >= FOCUS_REFRESH_MS) refresh();
  });
  // Opening the root reads its files, so the first focus counts from then.
  useEffect(() => {
    lastReadAt.current = Date.now();
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const handleFocus = () => onWindowFocus();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [expanded]);

  const handleExpandedChange = (next: boolean) => {
    setExpanded(next);
    if (next) refresh();
  };

  // A browsed file never becomes the chat's context file: it isn't in the chat's own project.
  const openInEditor = (path: string) =>
    openFile({
      path,
      name: path.split('/').pop() ?? path,
      projectPath: project.path,
      isOtherProject: true,
      isWorktreeContext: false,
      sourceChatId: chatId,
      sourcePaneIndex: paneIndex,
      intent: 'preview',
    });

  const rowAt = (path: string) =>
    containerRef.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"]`);
  // A row's click opens its file or toggles its folder, which is what these keys do here.
  const clickRow = (path: string) => rowAt(path)?.click();
  useFileTreeNavigation(containerRef, {
    selectedNode: selection.getPrimary(),
    getVisiblePaths: () => getVisiblePaths(containerRef.current),
    isInlineActive: false,
    onSelectByPath: (path) =>
      selection.selectOne(path, createMetaLookupFromDOM(containerRef.current)(path)),
    onClearSelection: selection.clearSelection,
    // Enter opens the row, and F2 does nothing: nothing here can be renamed.
    onEnter: clickRow,
    onStartRename: doNothing,
    onDuplicate: doNothing,
    onCopy: doNothing,
    onExpand: clickRow,
    onCollapse: clickRow,
    isExpanded: (path) => rowAt(path)?.getAttribute('aria-expanded') === 'true',
    onOpenFile: openInEditor,
  });

  // The marker covers the row as well as the tree, so focus on either is inside this root.
  return (
    <div data-read-only-root>
      <ProjectRootRow
        name={project.name}
        path={project.path}
        branch={branch}
        badge={BROWSING_BADGE}
        expanded={expanded}
        onExpandedChange={handleExpandedChange}
        controlsId={treeId}
        remove={{ label: `Remove ${project.name} from this tree`, onRemove }}
      />
      <div
        ref={containerRef}
        id={treeId}
        role="tree"
        aria-label={`${project.name} file tree`}
        aria-keyshortcuts={READ_ONLY_FILE_TREE_KEY_SHORTCUTS}
        aria-busy={isLoading ? 'true' : undefined}
        tabIndex={0}
        hidden={!expanded}
        className="px-2 py-1 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        {cantOpen ? (
          <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
            {`Can't open ${project.name}'s folder. It may have moved or been deleted.`}
          </p>
        ) : isLoading ? (
          <LoadingState />
        ) : (
          <ReadOnlyContext.Provider value={true}>
            <RefreshContext.Provider value={refreshTrigger}>
              <FileTree
                key={`${project.path}-${isSearching ? 'search' : 'browse'}`}
                nodes={nodes}
                projectPath={project.path}
                paneIndex={paneIndex}
                manageDnd={manageDnd}
                onFileClick={openInEditor}
                searchQuery={searchQuery}
                onSelect={(path, name, type) => selection.selectOne(path, { name, type })}
                selectionStore={selection.selectionStore}
              />
            </RefreshContext.Provider>
          </ReadOnlyContext.Provider>
        )}
      </div>
    </div>
  );
}
