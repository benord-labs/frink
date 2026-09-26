import { memo, type ReactElement } from 'react';
import type { FlowSemanticChange } from '../../../../../../shared/types/flows/flow-change-presentation';
import {
  describeFlowChange,
  visibleFlowChanges,
} from '../../../../../lib/flows/flow-change-outline';

type Props = { changes: FlowSemanticChange[] };

const CHANGE_STATUS_CLASS: Partial<Record<FlowSemanticChange['status'], string>> = {
  applied: 'text-[hsl(var(--status-online-text))]',
  pending: 'text-primary',
  failed: 'text-destructive',
  unknown: 'text-[hsl(var(--status-warning-foreground))]',
  skipped: 'text-[hsl(var(--status-warning-foreground))]',
};

export const ChangeDetails = memo(function ChangeDetails({ changes }: Props): ReactElement | null {
  const changesToShow = visibleFlowChanges(changes);
  if (changesToShow.length === 0) return null;
  return (
    <div
      className="mt-0.5 flex min-w-0 flex-col items-start gap-px text-start text-[10px] leading-[14px] text-muted-foreground wrap-anywhere"
      role="list"
    >
      {changesToShow.map((change) => (
        <span
          className={CHANGE_STATUS_CLASS[change.status]}
          key={`${change.kind}:${change.operationIndex}`}
          role="listitem"
        >
          {describeFlowChange(change)}
        </span>
      ))}
    </div>
  );
});
