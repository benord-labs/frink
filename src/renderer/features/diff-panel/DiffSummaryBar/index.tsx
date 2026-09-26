type DiffSummaryBarProps = {
  shownCount: number;
  totalCount: number;
  unrenderableCount: number;
  additions: number;
  deletions: number;
  isFiltered: boolean;
  onShowAll: () => void;
};

export function DiffSummaryBar({
  shownCount,
  totalCount,
  unrenderableCount,
  additions,
  deletions,
  isFiltered,
  onShowAll,
}: DiffSummaryBarProps) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/30 px-3 text-xs text-muted-foreground">
      <span>
        {isFiltered
          ? `Showing ${shownCount} of ${totalCount} files`
          : `${totalCount} ${totalCount === 1 ? 'file' : 'files'}`}
      </span>
      <span className="text-green-600 dark:text-green-400">+{additions}</span>
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
      {unrenderableCount > 0 && <span>· {unrenderableCount} can't be shown</span>}
      {isFiltered && (
        <button
          type="button"
          className="ml-auto text-foreground hover:underline"
          onClick={onShowAll}
        >
          Show all
        </button>
      )}
    </div>
  );
}
