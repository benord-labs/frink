import { useAtom } from 'jotai';
import type React from 'react';
import { memo, useCallback, useMemo } from 'react';
import { getPaneColor } from '@/lib/pane-colors';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { recentlyOpenedFilesAtom } from '../../agents/atoms';
import { getFileSearchIcon } from '../utils/file-icon';
import { SearchDialogShell } from './search-dialog-shell';
import { useDialogSearchState } from './use-dialog-search-state';

type FileSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  onSelectFile: (filePath: string) => void;
  /** When defined (split view active), shows a colored pane indicator */
  activePaneIndex?: number;
};

export const FileSearchDialog = memo(function FileSearchDialog({
  open,
  onOpenChange,
  projectPath,
  onSelectFile,
  activePaneIndex,
}: FileSearchDialogProps) {
  const {
    query,
    debouncedQuery,
    selectedIndex,
    setSelectedIndex,
    inputRef,
    handleQueryChange,
    setItemRef,
  } = useDialogSearchState({ open });
  const [recentlyOpenedFiles, setRecentlyOpenedFiles] = useAtom(recentlyOpenedFilesAtom);

  const { data: results } = trpc.files.search.useQuery(
    {
      projectPath,
      query: debouncedQuery,
      limit: 50,
    },
    {
      enabled: open && !!projectPath,
      placeholderData: (prev) => prev,
    },
  );

  // Build recent file items directly from atom (independent of search results)
  const recentItems = useMemo(() => {
    const prefix = `${projectPath}/`;
    const items: { id: string; label: string; path: string }[] = [];
    const queryLower = debouncedQuery.toLowerCase();
    for (const absPath of recentlyOpenedFiles) {
      if (!absPath.startsWith(prefix)) continue;
      const relPath = absPath.slice(prefix.length);
      const fileName = relPath.includes('/')
        ? relPath.slice(relPath.lastIndexOf('/') + 1)
        : relPath;
      // Filter by query if searching
      if (queryLower && !relPath.toLowerCase().includes(queryLower)) continue;
      items.push({ id: `recent-${relPath}`, label: fileName, path: relPath });
    }
    return items;
  }, [recentlyOpenedFiles, projectPath, debouncedQuery]);

  const recentPathsSet = useMemo(() => new Set(recentItems.map((f) => f.path)), [recentItems]);

  // Search results excluding recently opened files
  const otherFiles = useMemo(() => {
    const allFiles = (results ?? []).filter((item) => item.type === 'file');
    return allFiles.filter((file) => !recentPathsSet.has(file.path));
  }, [results, recentPathsSet]);

  // Flat list for keyboard navigation: recent first, then rest
  const allItems = useMemo(() => [...recentItems, ...otherFiles], [recentItems, otherFiles]);
  const recentCount = recentItems.length;

  const handleSelect = useCallback(
    (relativePath: string) => {
      const absolutePath = `${projectPath}/${relativePath}`;
      onSelectFile(absolutePath);
      onOpenChange(false);
    },
    [projectPath, onSelectFile, onOpenChange],
  );

  const handleRemoveRecent = useCallback(
    (relativePath: string) => {
      const absolutePath = `${projectPath}/${relativePath}`;
      setRecentlyOpenedFiles((prev) => prev.filter((p) => p !== absolutePath));
    },
    [projectPath, setRecentlyOpenedFiles],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
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
          handleSelect(file.path);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditableTarget) return;
        const file = allItems[selectedIndex];
        if (file && selectedIndex < recentCount) {
          e.preventDefault();
          handleRemoveRecent(file.path);
        }
      }
    },
    [allItems, selectedIndex, handleSelect, recentCount, handleRemoveRecent, setSelectedIndex],
  );

  const listboxId = 'file-search-results-listbox';
  const paneColor = activePaneIndex != null ? getPaneColor(activePaneIndex) : null;

  return (
    <SearchDialogShell
      open={open}
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
                  index={i}
                  optionId={`file-search-option-${i}`}
                  isSelected={i === selectedIndex}
                  onSelect={() => handleSelect(item.path)}
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
                    index={flatIndex}
                    optionId={`file-search-option-${flatIndex}`}
                    isSelected={flatIndex === selectedIndex}
                    onSelect={() => handleSelect(item.path)}
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
              <span className="[direction:ltr]">{dirPath}</span>
            </span>
          )}
        </span>
        {recentLabel && (
          <span className="text-xs text-muted-foreground/60 ml-auto shrink-0">{recentLabel}</span>
        )}
      </div>
    </div>
  );
});
