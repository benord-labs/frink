/**
 * List of flows for the Flows page.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import type { inferRouterOutputs } from '@trpc/server';
import { useSetAtom } from 'jotai';
import { GitBranch, Loader2, Play, Search, Zap } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AppRouter } from '../../../../main/lib/trpc/routers';
import type { FlowExecutionEvent } from '../../../../shared/types/flow';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../components/ui/alert-dialog';
import { Skeleton } from '../../../components/ui/skeleton';
import { flowsSelectedFlowIdAtom } from '../../../lib/atoms';
import { deleteFlowDraft, loadFlowDraftIds } from '../../../lib/flow-drafts';
import { groupFlowsIntoSections } from '../../../lib/flows/flow-list-sections';
import { hasOpenDialogLayer } from '../../../lib/has-open-dialog-layer';
import { isEditableKeyboardTarget } from '../../../lib/is-editable-keyboard-target';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { isDesktopApp } from '../../../lib/utils/platform';
import { flowRunDisplayStatus, shouldPollFlowAdmission } from '../FlowEditor/FlowRunStatusIcon';
import { FlowListSkeleton } from './FlowListSkeleton';
import { FlowListTable } from './FlowListTable';
import { FlowSortControl, type FlowSortOrder } from './FlowSortControl';

const FLOW_LIST_RUN_LEVEL_EVENTS = new Set<FlowExecutionEvent['eventType']>([
  'run_started',
  'run_paused',
  'run_completed',
  'run_failed',
  'run_cancelled',
]);

type FlowRow = inferRouterOutputs<AppRouter>['flows']['list'][number];

const displayStatusOf = (flow: FlowRow): string | null =>
  flow.latest_run_status
    ? flowRunDisplayStatus(
        flow.latest_run_status,
        flow.latest_run_active_task_status,
        flow.latest_run_admission_state,
      )
    : null;

/** A run is live (drives the dashboard indicator) while pending/running/paused. */
const isFlowRunLive = (status: string | null | undefined): boolean =>
  status === 'running' || status === 'paused' || status === 'pending';

type FlowsListProps = {
  onCreateClick: () => void;
};

export function FlowsList({ onCreateClick }: FlowsListProps): ReactElement {
  const setSelectedFlowId = useSetAtom(flowsSelectedFlowIdAtom);
  const utils = trpc.useUtils();
  const {
    data: flows,
    isLoading,
    isError,
    refetch,
  } = trpc.flows.list.useQuery(undefined, {
    // Poll while any run is live: a paused run's driving-task status (Running ↔ Awaiting input) can
    // change without a run-level socket event, so socket invalidation alone leaves the pill stale.
    refetchInterval: (query) => {
      const currentFlows = query.state.data ?? [];
      if (
        currentFlows.some((flow) =>
          shouldPollFlowAdmission(flow.latest_run_status, flow.latest_run_admission_state),
        )
      ) {
        return 5_000;
      }
      return currentFlows.some((flow) => isFlowRunLive(flow.latest_run_status)) ? 15_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  // flowIds with unsaved local edits — recomputed each render (cheap, one map read) so the
  // "Unsaved changes" pill stays accurate across list invalidations.
  const draftIds = loadFlowDraftIds();
  const deleteMutation = trpc.flows.delete.useMutation({
    onSuccess: (_data, variables) => {
      deleteFlowDraft(variables.id); // drop the orphaned local draft for the deleted flow
      void utils.flows.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || 'Could not delete flow');
    },
  });
  const [deleteTarget, setDeleteTarget] = useState<FlowRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<FlowSortOrder>('updated_at');
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to search from anywhere on the page, like Linear and GitHub.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (isEditableKeyboardTarget(event.target) || hasOpenDialogLayer()) return;
      if (!searchRef.current) return;
      event.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.onSocketFlowExecutionEvent) return;

    const unsubscribe = window.desktopApi.onSocketFlowExecutionEvent(
      (event: FlowExecutionEvent) => {
        if (!FLOW_LIST_RUN_LEVEL_EVENTS.has(event.eventType)) return;
        void utils.flows.list.invalidate();
      },
    );

    return unsubscribe;
  }, [utils]);

  const handleOpen = useCallback(
    (id: string) => {
      setSelectedFlowId(id);
    },
    [setSelectedFlowId],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ id: deleteTarget.id });
      setDeleteTarget(null);
    } catch {
      // Error handled by deleteMutation onError (toast).
    }
  }, [deleteMutation, deleteTarget]);

  const rawList = useMemo(() => (Array.isArray(flows) ? flows : []), [flows]);

  const filteredAndSorted = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let result = q
      ? rawList.filter(
          (f) =>
            f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q),
        )
      : rawList;
    if (sortOrder === 'name') {
      result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    }
    return result;
  }, [rawList, searchQuery, sortOrder]);
  const sections = useMemo(
    () => groupFlowsIntoSections(filteredAndSorted, displayStatusOf),
    [filteredAndSorted],
  );

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
        <div className="flex gap-2 py-2">
          <Skeleton className="h-8 flex-1 rounded-[var(--field-radius)] bg-accent" />
          <Skeleton className="h-8 w-[9.875rem] rounded-[var(--field-radius)] bg-accent" />
        </div>
        <div className="pt-2">
          <FlowListSkeleton />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-muted-foreground">Could not load flows.</p>
        <Button type="button" variant="secondary" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {rawList.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 py-2">
          <div className="relative flex-1 min-w-0">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none"
              aria-hidden
            />
            <Input
              ref={searchRef}
              type="search"
              placeholder="Search flows"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                if (searchQuery) setSearchQuery('');
                else e.currentTarget.blur();
              }}
              size="sm"
              className="pl-8 pr-8"
              aria-label="Search flows"
              aria-keyshortcuts="/"
            />
            {searchQuery ? null : (
              <kbd
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border/60 px-1.5 font-sans text-xs leading-4 text-muted-foreground"
                aria-hidden
              >
                /
              </kbd>
            )}
          </div>
          <FlowSortControl sortOrder={sortOrder} onSortChange={setSortOrder} />
        </div>
      )}

      {/* Empty state — no flows at all */}
      {rawList.length === 0 && (
        <div className="flex flex-1 items-center justify-center p-4">
          <div
            className={cn(
              'group flex w-full max-w-sm flex-col items-center rounded-xl border-2 border-dashed border-border/45 p-10 text-center',
              'transition-all duration-300 hover:border-border/60 hover:bg-muted/15',
            )}
          >
            <div className="flex justify-center mb-5 isolate">
              <div className="bg-card size-10 grid place-items-center rounded-xl relative left-2 top-1 -rotate-6 shadow-md ring-1 ring-border/60 group-hover:-translate-x-4 group-hover:-rotate-12 group-hover:-translate-y-0.5 transition-all duration-300">
                <GitBranch className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="bg-card size-10 grid place-items-center rounded-xl relative z-10 shadow-md ring-1 ring-border/60 group-hover:-translate-y-1 transition-all duration-300">
                <Zap className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="bg-card size-10 grid place-items-center rounded-xl relative right-2 top-1 rotate-6 shadow-md ring-1 ring-border/60 group-hover:translate-x-4 group-hover:rotate-12 group-hover:-translate-y-0.5 transition-all duration-300">
                <Play className="h-5 w-5 text-muted-foreground" />
              </div>
            </div>
            <p className="text-base font-medium">No flows yet</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-[220px]">
              Automate tasks with a sequence of steps triggered by events.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCreateClick}
              className="shadow-xs"
            >
              Create your first flow
            </Button>
          </div>
        </div>
      )}

      {/* No search results */}
      {rawList.length > 0 && filteredAndSorted.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-sm font-medium">No flows match</p>
          <p className="text-xs text-muted-foreground">Try a different search term.</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSearchQuery('')}>
            Clear search
          </Button>
        </div>
      )}

      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-2 [scrollbar-gutter:stable]">
        {sections.length > 0 ? (
          <FlowListTable
            sections={sections}
            draftIds={draftIds}
            displayStatusOf={displayStatusOf}
            onOpen={handleOpen}
            onDelete={setDeleteTarget}
          />
        ) : null}
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (o) return;
          if (deleteMutation.isPending) return;
          setDeleteTarget(null);
        }}
      >
        <AlertDialogContent aria-busy={deleteMutation.isPending}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete flow?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.name}" and its run history will be permanently deleted. Any active run will be stopped.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => void confirmDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
