import { Badge } from '@benord-labs/frink-primitives';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { agentsPageHeaderClass } from '../../../../components/ChatAtmosphereSurface/constants';
import { QueueHeaderActions } from '../QueueHeaderActions';

type Props = {
  headingRef: RefObject<HTMLHeadingElement | null>;
  isLoading: boolean;
  openTaskCount: number;
  /** Sidebar-reopen affordance, rendered ahead of the title when the destination offers one. */
  sidebarTrigger?: ReactNode;
  backToOverviewButtonRef: RefObject<HTMLButtonElement | null>;
  canDeleteAll: boolean;
  isDeletingAll: boolean;
  isHistoryView: boolean;
  isMutating: boolean;
  onClose: () => void;
  onDeleteAll: () => void;
  onReturnToOverview: () => void;
};

export function QueueHeader({
  headingRef,
  isLoading,
  openTaskCount,
  sidebarTrigger,
  ...actionsProps
}: Props): ReactElement {
  return (
    <header className={agentsPageHeaderClass(Boolean(sidebarTrigger))}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {sidebarTrigger}
        <h1
          id="work-queue-heading"
          ref={headingRef}
          tabIndex={-1}
          className="truncate rounded-sm text-xl font-semibold text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          Work Queue
        </h1>
        {!isLoading && (
          <Badge
            shape="count"
            className="bg-elevated text-muted-fg"
            aria-label={`${openTaskCount} open ${openTaskCount === 1 ? 'task' : 'tasks'}`}
          >
            {openTaskCount}
          </Badge>
        )}
      </div>
      <QueueHeaderActions {...actionsProps} />
    </header>
  );
}
