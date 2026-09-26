/**
 * Structured table view for fan-out node results in the Flow Run History panel.
 *
 * Replaces the raw JSON block rendered by TruncatedJsonBlock when a node run's outputs contain
 * `_fanOutState: "completed"`. Each row is a lane, with status badge, summary, and optional
 * "Open Chat" link.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useMemo, useState } from 'react';
import { parseFanOutItem } from './parse-fan-out-lane';
import { ResultRow } from './result-row';
import { type StatusFilter, StatusFilterBar } from './status-filter';

const PAGE_SIZE = 50;

type FanOutResultsTableProps = {
  results: unknown[];
  totalCount: number;
  nodeLabelById: ReadonlyMap<string, string>;
};

export function FanOutResultsTable({
  results,
  totalCount,
  nodeLabelById,
}: FanOutResultsTableProps) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);

  const lanes = useMemo(() => results.flatMap(parseFanOutItem), [results]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: lanes.length,
      passed: 0,
      failed: 0,
      skipped: 0,
      unknown: 0,
    };
    for (const l of lanes) {
      c[l.status]++;
    }
    return c;
  }, [lanes]);

  const filtered = useMemo(
    () => (filter === 'all' ? lanes : lanes.filter((l) => l.status === filter)),
    [lanes, filter],
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleFilterChange = (f: StatusFilter) => {
    setFilter(f);
    setPage(0);
  };

  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Fan-out results
        </span>
        {totalCount > 0 && (
          <span className="text-[10px] text-muted-foreground/50 tabular-nums">
            {lanes.length} results / {totalCount} items
          </span>
        )}
      </div>

      {counts.all > 0 ? (
        <>
          <StatusFilterBar counts={counts} active={filter} onChange={handleFilterChange} />

          <div className="rounded border border-border/40 overflow-hidden">
            <table className="w-full table-fixed text-left">
              <colgroup>
                <col className="w-6" />
                <col className="w-12" />
                <col />
                <col className="w-16" />
              </colgroup>
              <thead>
                <tr className="border-b border-border/40 bg-muted/20">
                  <th className="py-0.5 pl-1 text-[9px] font-medium text-muted-foreground/50">
                    Item
                  </th>
                  <th className="py-0.5 text-[9px] font-medium text-muted-foreground/50">Status</th>
                  <th className="py-0.5 text-[9px] font-medium text-muted-foreground/50">
                    Branch / summary
                  </th>
                  <th className="py-0.5 text-right text-[9px] font-medium text-muted-foreground/50" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((lane) => (
                  <ResultRow
                    key={`${lane.laneIndex}:${lane.branchRootNodeId}`}
                    {...lane}
                    branchLabel={nodeLabelById.get(lane.branchRootNodeId) ?? 'Branch'}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span className="text-[10px] text-muted-foreground/50">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of{' '}
                {filtered.length}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="h-auto rounded px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground"
                >
                  ‹ Prev
                </Button>
                <Button
                  variant="ghost"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                  className="h-auto rounded px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground"
                >
                  Next ›
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-[10px] text-muted-foreground/50 italic">No lane results recorded.</p>
      )}
    </div>
  );
}
