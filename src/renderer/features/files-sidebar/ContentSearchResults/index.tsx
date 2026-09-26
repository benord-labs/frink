import { Button } from '@benord-labs/frink-primitives';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { LoadingState } from '../LoadingState';
import type { ContentSearchMatch } from '../types/content-search-match';

type ContentSearchResultsProps = {
  isLoading: boolean;
  query: string;
  invalidRegex: boolean;
  matches: ContentSearchMatch[];
  onSelectMatch: (
    relativePath: string,
    lineNumber: number,
    startColumn: number,
    endColumn: number,
  ) => void;
  renderLine: (lineText: string) => string | ReactNode[];
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 50;

export function ContentSearchResults({
  isLoading,
  query,
  invalidRegex,
  matches,
  onSelectMatch,
  renderLine,
  pageSize = DEFAULT_PAGE_SIZE,
}: ContentSearchResultsProps) {
  const trimmedQuery = query.trim();
  const [visibleCount, setVisibleCount] = useState(pageSize);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset visible window when trimmed query, regex validity, or result set changes
  useEffect(() => {
    setVisibleCount(pageSize);
  }, [pageSize, matches.length, trimmedQuery, invalidRegex]);

  const visibleMatches = useMemo(() => matches.slice(0, visibleCount), [matches, visibleCount]);
  const remainingMatches = Math.max(matches.length - visibleMatches.length, 0);
  const groupedVisibleMatches = useMemo(() => {
    const groupedMap = new Map<string, ContentSearchMatch[]>();
    visibleMatches.forEach((match) => {
      const existing = groupedMap.get(match.filePath);
      if (existing) {
        existing.push(match);
      } else {
        groupedMap.set(match.filePath, [match]);
      }
    });
    return Array.from(groupedMap.entries()).map(([filePath, fileMatches]) => ({
      filePath,
      matches: fileMatches,
    }));
  }, [visibleMatches]);
  const matchedFileCount = useMemo(() => {
    return new Set(matches.map((match) => match.filePath)).size;
  }, [matches]);

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
      {isLoading ? (
        <LoadingState />
      ) : trimmedQuery.length === 0 ? (
        <div className="text-xs text-muted-foreground px-2 py-1">Type to search inside files.</div>
      ) : invalidRegex ? (
        <div className="text-xs text-destructive px-2 py-1">Invalid regular expression.</div>
      ) : matches.length === 0 ? (
        <div className="text-xs text-muted-foreground px-2 py-1">No matches found.</div>
      ) : (
        <>
          <div className="px-1 pb-1 text-[11px] text-muted-foreground">
            {`${matches.length} results in ${matchedFileCount} files`}
          </div>
          {groupedVisibleMatches.map((fileGroup) => (
            <section
              key={fileGroup.filePath}
              className="rounded-md border border-border/40 bg-muted/20 overflow-hidden"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border/40 px-2 py-1">
                <div className="text-xs font-medium truncate" title={fileGroup.filePath}>
                  {fileGroup.filePath}
                </div>
                <div className="text-[11px] text-muted-foreground shrink-0">
                  {fileGroup.matches.length} {fileGroup.matches.length === 1 ? 'result' : 'results'}
                </div>
              </div>
              <div className="py-0.5">
                {fileGroup.matches.map((match) => (
                  <Button
                    variant="ghost"
                    size="auto"
                    key={match.id}
                    onClick={() =>
                      onSelectMatch(
                        match.filePath,
                        match.lineNumber,
                        match.startColumn,
                        match.endColumn,
                      )
                    }
                    className="w-full justify-start text-left font-normal rounded-none px-2 py-1"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] text-muted-foreground tabular-nums min-w-[42px] text-right pt-0.5">
                        {match.lineNumber}
                      </span>
                      <span className="text-xs text-foreground/90 truncate">
                        {renderLine(match.lineText)}
                      </span>
                    </div>
                  </Button>
                ))}
              </div>
            </section>
          ))}
          {remainingMatches > 0 && (
            <Button
              variant="secondary"
              size="sm"
              className="w-full border-border/40 px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50"
              onClick={() => setVisibleCount((prev) => prev + pageSize)}
            >
              {`Show ${Math.min(pageSize, remainingMatches)} more (${remainingMatches} remaining)`}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
