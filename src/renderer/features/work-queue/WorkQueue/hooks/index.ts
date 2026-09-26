import type { RefObject } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useWorkQueueDismissal } from '../../../../lib/work-queue/use-work-queue-dismissal';

const WORK_QUEUE_REFETCH_INTERVAL_MS = 5000;

export function useLoadedTaskDisclosure<T>(items: T[], initialCount: number) {
  const [isExpanded, setIsExpanded] = useState(false);
  const listId = useId();
  const additionalItemCount = Math.max(0, items.length - initialCount);

  return {
    additionalItemCount,
    isExpanded,
    listId,
    toggleExpanded: () => setIsExpanded((expanded) => !expanded),
    visibleItems: isExpanded ? items : items.slice(0, initialCount),
  };
}

export function getHistoryRefetchInterval(view: WorkQueueViewMode): number | false {
  return view === 'history' ? WORK_QUEUE_REFETCH_INTERVAL_MS : false;
}

type WorkQueueView = {
  backToOverviewButtonRef: RefObject<HTMLButtonElement | null>;
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  historyRefetchInterval: number | false;
  isHistoryView: boolean;
  openHistory: () => void;
  returnToOverview: () => void;
};

export type WorkQueueViewMode = 'overview' | 'history';

export function useWorkQueueView(onRequestClose: () => void): WorkQueueView {
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const backToOverviewButtonRef = useRef<HTMLButtonElement>(null);
  const previousViewRef = useRef<WorkQueueViewMode>('overview');
  const [view, setView] = useState<WorkQueueViewMode>('overview');
  const isHistoryView = view === 'history';
  const openHistory = useCallback(() => setView('history'), []);
  const returnToOverview = useCallback(() => setView('overview'), []);
  const handleDismissal = useCallback(() => {
    if (view !== 'overview') returnToOverview();
    else onRequestClose();
  }, [onRequestClose, returnToOverview, view]);
  useWorkQueueDismissal(handleDismissal);

  useEffect(() => {
    const previousView = previousViewRef.current;
    if (view === 'history') {
      backToOverviewButtonRef.current?.focus();
    } else if (previousView === 'history') {
      historyButtonRef.current?.focus();
    }
    previousViewRef.current = view;
  }, [view]);

  return {
    backToOverviewButtonRef,
    historyButtonRef,
    historyRefetchInterval: getHistoryRefetchInterval(view),
    isHistoryView,
    openHistory,
    returnToOverview,
  };
}
