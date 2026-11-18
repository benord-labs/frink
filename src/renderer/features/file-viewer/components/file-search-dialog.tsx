import { Badge } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { getPaneColor } from '@/lib/pane-colors';
import { cn } from '@/lib/utils';
import { findProjectForPath } from '@/lib/workspace-context/project-paths';
import type { QuickOpenRoot } from '@/lib/workspace-context/use-quick-open-roots';
import { useRootSearches } from '@/lib/workspace-context/use-root-searches';
import { recentlyOpenedFilesAtom } from '../../agents/atoms';
import { getFileSearchIcon } from '../utils/file-icon';
import { SearchDialogShell } from './search-dialog-shell';
import { SearchScopePills } from './SearchScopePills';
import { useDialogSearchState } from './use-dialog-search-state';

type FileSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The folders searched: the chat's own first, then each other project in its file tree */
  roots: QuickOpenRoot[];
  onSelectFile: (filePath: string, root: QuickOpenRoot) => void;
  /** When defined (split view active), shows a colored pane indicator */
  activePaneIndex?: number;
};

/** A file by its path relative to the folder it was found in */
type FileItem = { id: string; label: string; path: string; root: QuickOpenRoot };

const absolutePathOf = (item: FileItem) => `${item.root.path}/${item.path}`;

export const FileSearchDialog = memo(function FileSearchDialog({
  open,
  onOpenChange,
  roots,
  onSelectFile,
  activePaneIndex,
}: FileSearchDialogProps) {
  // With nothing to search (a split pane with no project chat) the dialog stays shut and drops the
  // open, which would otherwise pop it up by itself once a pane with files is active.
  const isOpen = open && roots.length > 0;
  useEffect(() => {
    if (open && roots.length === 0) onOpenChange(false);
  }, [open, roots.length, onOpenChange]);
  const {
    query,
    debouncedQuery,
    selectedIndex,
    setSelectedIndex,
    scope,
    handleScopeChange,
    inputRef,
    handleQueryChange,
    setItemRef,
  } = useDialogSearchState({ open: isOpen });
  const [recentlyOpenedFiles, setRecentlyOpenedFiles] = useAtom(recentlyOpenedFilesAtom);
  // A chosen project that leaves the tree while the dialog is open widens the search to them all.
  const activeScope = roots.some((root) => root.path === scope) ? scope : null;
  const inScope = useMemo(
    () => (activeScope === null ? roots : roots.filter((root) => root.path === activeScope)),
    [roots, activeScope],
  );
  const { results } = useRootSearches(inScope, debouncedQuery, isOpen);

  // Build recent file items directly from atom (independent of search results)
  const recentItems = useMemo(() => {
    const items: FileItem[] = [];
    const queryLower = debouncedQuery.toLowerCase();
    for (const absPath of recentlyOpenedFiles) {
      // The deepest folder holding the file, when one project in the tree lies inside another.
      const root = findProjectForPath(absPath, inScope);
      const relPath = root ? absPath.slice(root.path.length + 1) : '';
      if (!root || !relPath) continue;
      const fileName = relPath.includes('/')
        ? relPath.slice(relPath.lastIndexOf('/') + 1)
        : relPath;
      // Filter by query if searching
      if (queryLower && !relPath.toLowerCase().includes(queryLower)) continue;
      items.push({ id: `recent-${absPath}`, label: fileName, path: relPath, root });
    }
    return items;
  }, [recentlyOpenedFiles, inScope, debouncedQuery]);

  const recentPathsSet = useMemo(() => new Set(recentItems.map(absolutePathOf)), [recentItems]);

  // Search results excluding recently opened files, the chat's folder first. Ids are unique only
  // within a folder, so each is prefixed with its folder.
  const otherFiles = useMemo(
    () =>
      inScope.flatMap((root, i) =>
        (results[i] ?? [])
          .map((item) => ({ ...item, id: `${root.path}:${item.id}`, root }))
          .filter((file) => file.type === 'file' && !recentPathsSet.has(absolutePathOf(file))),
      ),
    [inScope, results, recentPathsSet],
  );

  // Flat list for keyboard navigation: recent first, then rest
  const allItems = useMemo(() => [...recentItems, ...otherFiles], [recentItems, otherFiles]);
  const recentCount = recentItems.length;

  const handleSelect = useCallback(
    (item: FileItem) => {
      onSelectFile(absolutePathOf(item), item.root);
      onOpenChange(false);
    },
    [onSelectFile, onOpenChange],
  );

  const handleRemoveRecent = useCallback(
    (item: FileItem) => {
      setRecentlyOpenedFiles((prev) => prev.filter((p) => p !== absolutePathOf(item)));
    },
    [setRecentlyOpenedFiles],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A scope pill handles its own keys: Enter and Space press it.
      if (target instanceof HTMLButtonElement) return;
      const isEditableTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (allItems.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % allItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + allItems.length) % allItems.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const file = allItems[selectedIndex];
        if (file) {
          handleSelect(file);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditableTarget) return;
        const file = allItems[selectedIndex];
        if (file && selectedIndex < recentCount) {
          e.preventDefault();
          handleRemoveRecent(file);
        }
      }
    },
    [allItems, selectedIndex, handleSelect, recentCount, handleRemoveRecent, setSelectedIndex],
  );

  const listboxId = 'file-search-results-listbox';
  const paneColor = activePaneIndex != null ? getPaneColor(activePaneIndex) : null;

  return (
    <SearchDialogShell
      open={isOpen}
      onOpenChange={onOpenChange}
      title="Search files"
      description="Search and open project files."
      inputId="file-search-input"
      inputRef={inputRef}
      inputPlaceholder="Go to file..."
      inputValue={query}
      onInputChange={handleQueryChange}
      inputProps={{
        role: 'combobox',
        'aria-expanded': allItems.length > 0,
        'aria-controls': listboxId,
        'aria-activedescendant': allItems[selectedIndex]
          ? `file-search-option-${selectedIndex}`
          : undefined,
      }}
      onKeyDown={handleKeyDown}
      activePaneIndex={activePaneIndex}
      paneDotClassName={paneColor?.badgeBg}
      paneDotBorderClassName={paneColor?.badgeBorder}
      paneBorderClassName={paneColor?.border}
      contentWidthClassName="ml-[-300px] w-[600px]"
      toolbar={
        roots.length > 1 && (
          <SearchScopePills roots={roots} scope={activeScope} onScopeChange={handleScopeChange} />
        )
      }
    >
      <div
        id={listboxId}
        role="listbox"
        className="flex-1 overflow-y-auto py-1 max-h-[400px] border-t scrollbar-hide"
      >
        {allItems.length === 0 && debouncedQuery ? (
          <div className="min-h-[32px] py-[5px] px-1.5 mx-1 flex items-center text-sm text-muted-foreground">
            No files found
          </div>
        ) : (
          <>
            {/* Recently opened files (shown at top, no section header) */}
            {recentItems.map((item, i) => {
              const dirPath = item.path.includes('/')
                ? item.path.slice(0, item.path.lastIndexOf('/'))
                : '';
              return (
                <FileSearchItem
                  key={item.id}
                  label={item.label}
                  dirPath={dirPath}
                  project={item.root.isChat ? undefined : item.root.name}
                  index={i}
                  optionId={`file-search-option-${i}`}
                  isSelected={i === selectedIndex}
                  onSelect={() => handleSelect(item)}
                  setRef={setItemRef}
                  recentLabel="recently opened"
                />
              );
            })}

            {/* Other files section */}
            {otherFiles.length > 0 &&
              otherFiles.map((item, i) => {
                const flatIndex = recentCount + i;
                const dirPath = item.path.includes('/')
                  ? item.path.slice(0, item.path.lastIndexOf('/'))
                  : '';
                return (
                  <FileSearchItem
                    key={item.id}
                    label={item.label}
                    dirPath={dirPath}
                    project={item.root.isChat ? undefined : item.root.name}
                    index={flatIndex}
                    optionId={`file-search-option-${flatIndex}`}
                    isSelected={flatIndex === selectedIndex}
                    onSelect={() => handleSelect(item)}
                    setRef={setItemRef}
                  />
                );
              })}
          </>
        )}
      </div>
    </SearchDialogShell>
  );
});

type FileSearchItemProps = {
  label: string;
  dirPath: string;
  /** The other project the file is in; nothing shows for the chat's own folder */
  project?: string;
  index: number;
  optionId: string;
  isSelected: boolean;
  onSelect: () => void;
  setRef: (index: number, el: HTMLElement | null) => void;
  recentLabel?: string;
};

const FileSearchItem = memo(function FileSearchItem({
  label,
  dirPath,
  project,
  index,
  optionId,
  isSelected,
  onSelect,
  setRef,
  recentLabel,
}: FileSearchItemProps) {
  const handleRef = useCallback(
    (el: HTMLDivElement | null) => {
      setRef(index, el);
    },
    [setRef, index],
  );

  // biome-ignore lint/style/useNamingConvention: component type variable
  const Icon = getFileSearchIcon(label);

  return (
    <div className="relative mx-1">
      <div
        ref={handleRef}
        id={optionId}
        role="option"
        aria-selected={isSelected}
        tabIndex={-1}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          'flex items-center gap-1.5 px-1.5 w-full text-left',
          'min-h-[44px] py-2',
          'rounded-md text-sm cursor-pointer select-none',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          'transition-colors group',
          isSelected
            ? 'dark:bg-neutral-800 bg-accent text-foreground'
            : 'text-muted-foreground dark:hover:bg-neutral-800 hover:bg-accent hover:text-foreground',
        )}
      >
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex items-center gap-1.5 w-full min-w-0 pr-12">
          <span className="shrink-0 whitespace-nowrap">{label}</span>
          {dirPath && (
            <span className="text-muted-foreground flex-1 min-w-0 ml-1 font-mono overflow-hidden text-xs [direction:rtl] text-left whitespace-nowrap">
              <span className="[direction:ltr] [unicode-bidi:isolate]">{dirPath}</span>
            </span>
          )}
        </span>
        {project && (
          <Badge
            shape="tag"
            title={project}
            className="max-w-40 shrink-0 bg-foreground/5 text-muted-foreground"
          >
            <span className="truncate">{project}</span>
          </Badge>
        )}
        {recentLabel && (
          <span className="text-xs text-muted-foreground/60 ml-auto shrink-0">{recentLabel}</span>
        )}
      </div>
    </div>
  );
});
