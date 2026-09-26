import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc, trpcClient } from '../../../../lib/trpc';
import { dedupeRowsById } from '../../utils/dedupe-rows-by-id';

const OVERVIEW_PAGE_SIZE = 50;
const OVERVIEW_POLL_MS = 5000;
type Section = 'attention' | 'inbox' | 'running';
type Cursor = { createdAt: string; id: string };
type Row = { id: string };
type Tail = { boundaryKey: string; nextCursor: Cursor | null; rows: Row[] };

const cursorKey = (cursor: Cursor | null) => (cursor ? `${cursor.createdAt}:${cursor.id}` : 'end');
const rowId = (row: Row) => row.id;

const matchingTail = (tail: Tail | null, boundaryKey: string) =>
  tail?.boundaryKey === boundaryKey ? tail : null;

function useSectionTail(section: Section, enabled: boolean, headCursor: Cursor | null) {
  const [tail, setTail] = useState<Tail | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);
  const boundaryKey = cursorKey(headCursor);
  const boundaryRef = useRef(boundaryKey);
  boundaryRef.current = boundaryKey;
  const tailBoundaryRef = useRef(boundaryKey);
  useEffect(() => {
    if (tailBoundaryRef.current === boundaryKey) return;
    tailBoundaryRef.current = boundaryKey;
    generationRef.current += 1;
    setTail(null);
  }, [boundaryKey]);
  const currentTail = matchingTail(tail, boundaryKey);
  const nextCursor = currentTail ? currentTail.nextCursor : headCursor;
  const loadMore = useCallback(async () => {
    if (!enabled || !nextCursor || inFlightRef.current) return;
    inFlightRef.current = true;
    setIsLoadingMore(true);
    const generation = generationRef.current;
    try {
      const page = await trpcClient.tasks.listPaginated.query({
        workQueueSection: section,
        limit: OVERVIEW_PAGE_SIZE,
        cursor: nextCursor,
        collapseByFlow: true,
      });
      if (boundaryRef.current !== boundaryKey || generationRef.current !== generation) return;
      setTail((previous) => ({
        boundaryKey,
        nextCursor: page.nextCursor,
        rows: dedupeRowsById([...(matchingTail(previous, boundaryKey)?.rows ?? []), ...page.items]),
      }));
    } finally {
      inFlightRef.current = false;
      setIsLoadingMore(false);
    }
  }, [boundaryKey, enabled, nextCursor, section]);
  const reset = useCallback(() => {
    generationRef.current += 1;
    setTail(null);
  }, []);
  return {
    canLoadMore: nextCursor !== null,
    isLoadingMore,
    loadMore,
    reset,
    tailRows: currentTail?.rows ?? [],
  };
}

function useSectionHead(section: Section, enabled: boolean) {
  const query = trpc.tasks.listPaginated.useQuery(
    { workQueueSection: section, limit: OVERVIEW_PAGE_SIZE, cursor: null, collapseByFlow: true },
    { enabled, refetchInterval: enabled ? OVERVIEW_POLL_MS : false, structuralSharing: true },
  );
  const tail = useSectionTail(section, enabled, (query.data?.nextCursor ?? null) as Cursor | null);
  const { tailRows, ...pagination } = tail;
  return {
    ...pagination,
    isLoading: query.isLoading,
    refetch: query.refetch,
    rows: dedupeRowsById([...(query.data?.items ?? []), ...tailRows]),
  };
}

export function useWorkQueueOverviewPages(enabled: boolean) {
  const attention = useSectionHead('attention', enabled);
  const runningHead = useSectionHead('running', enabled);
  const inboxHead = useSectionHead('inbox', enabled);
  const attentionIds = new Set(attention.rows.map(rowId));
  const running = {
    ...runningHead,
    rows: runningHead.rows.filter((row) => !attentionIds.has(rowId(row))),
  };
  const liveIds = new Set([...attentionIds, ...running.rows.map(rowId)]);
  const inbox = {
    ...inboxHead,
    rows: inboxHead.rows.filter((row) => !liveIds.has(rowId(row))),
  };
  const refresh = useCallback(async () => {
    attention.reset();
    runningHead.reset();
    inboxHead.reset();
    await Promise.all([attention.refetch(), runningHead.refetch(), inboxHead.refetch()]);
  }, [
    attention.refetch,
    attention.reset,
    inboxHead.refetch,
    inboxHead.reset,
    runningHead.refetch,
    runningHead.reset,
  ]);

  return {
    attention,
    inbox,
    isLoading: attention.isLoading || runningHead.isLoading || inboxHead.isLoading,
    refresh,
    running,
  };
}
