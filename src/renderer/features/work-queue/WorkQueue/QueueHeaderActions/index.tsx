import { Button } from '@benord-labs/frink-primitives';
import { ArrowLeft, X } from 'lucide-react';
import type { ReactElement, RefObject } from 'react';

type Props = {
  backToOverviewButtonRef: RefObject<HTMLButtonElement | null>;
  canDeleteAll: boolean;
  isDeletingAll: boolean;
  isHistoryView: boolean;
  isMutating: boolean;
  onClose: () => void;
  onDeleteAll: () => void;
  onReturnToOverview: () => void;
};

type HistoryActionsProps = Pick<
  Props,
  | 'backToOverviewButtonRef'
  | 'canDeleteAll'
  | 'isDeletingAll'
  | 'isMutating'
  | 'onDeleteAll'
  | 'onReturnToOverview'
>;

function BackAction({
  backToOverviewButtonRef,
  onReturnToOverview,
}: Pick<Props, 'backToOverviewButtonRef' | 'onReturnToOverview'>): ReactElement {
  return (
    <Button
      ref={backToOverviewButtonRef}
      type="button"
      variant="secondary"
      size="sm"
      onClick={onReturnToOverview}
      className="h-7 border-border/50 px-2 text-xs"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Back to overview
    </Button>
  );
}

function DeleteAllAction({
  isDeletingAll,
  isMutating,
  onDeleteAll,
}: Pick<Props, 'isDeletingAll' | 'isMutating' | 'onDeleteAll'>): ReactElement {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onDeleteAll}
      disabled={isMutating}
      aria-busy={isDeletingAll}
      className="h-7 border-border/50 px-2 text-xs"
    >
      {isDeletingAll ? 'Deleting...' : 'Delete all'}
    </Button>
  );
}

function HistoryActions({
  backToOverviewButtonRef,
  canDeleteAll,
  isDeletingAll,
  isMutating,
  onDeleteAll,
  onReturnToOverview,
}: HistoryActionsProps): ReactElement {
  return (
    <>
      <BackAction
        backToOverviewButtonRef={backToOverviewButtonRef}
        onReturnToOverview={onReturnToOverview}
      />
      {canDeleteAll && (
        <DeleteAllAction
          isDeletingAll={isDeletingAll}
          isMutating={isMutating}
          onDeleteAll={onDeleteAll}
        />
      )}
    </>
  );
}

function CloseAction({ onClose }: Pick<Props, 'onClose'>): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClose}
      className="h-7 w-7 shrink-0"
      aria-label="Close Work Queue"
      iconOnly
    >
      <X className="h-4 w-4" aria-hidden />
    </Button>
  );
}

export function QueueHeaderActions({
  backToOverviewButtonRef,
  canDeleteAll,
  isDeletingAll,
  isHistoryView,
  isMutating,
  onClose,
  onDeleteAll,
  onReturnToOverview,
}: Props): ReactElement {
  return (
    <div className="no-drag ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5">
      {isHistoryView ? (
        <HistoryActions
          backToOverviewButtonRef={backToOverviewButtonRef}
          canDeleteAll={canDeleteAll}
          isDeletingAll={isDeletingAll}
          isMutating={isMutating}
          onDeleteAll={onDeleteAll}
          onReturnToOverview={onReturnToOverview}
        />
      ) : null}
      <CloseAction onClose={onClose} />
    </div>
  );
}
