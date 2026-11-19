import { Button } from '@benord-labs/frink-primitives';
import { memo, type ReactElement, useState } from 'react';
import type { TriggerContext } from '../../../../../shared/types/trigger-context';
import { formatShortTimeAgo } from '../../../../lib/utils/format-time';
import { heldRunCopy } from '../../../../lib/work-queue/held-runs/held-run-copy';
import {
  type HeldRun,
  type HeldRunActions,
  useHeldRunActions,
  useHeldRuns,
} from '../../../../lib/work-queue/held-runs/use-held-runs';
import { admissionTrigger } from '../../utils/admission-subject';
import { TriggerContentDialog } from '../ActionMenu/TriggerContentDialog';
import { TaskActivityList } from '../TaskActivityList';
import { TaskActivityRow } from '../TaskActivityRow';

const MAX_VISIBLE_HELD_RUNS = 6;

type RowProps = {
  run: HeldRun;
  actions: HeldRunActions;
  onViewTrigger: (trigger: TriggerContext) => void;
};

function HeldRunRow({ run, actions, onViewTrigger }: RowProps): ReactElement {
  const trigger = admissionTrigger(run.trigger_context, false);
  const { source, description } = heldRunCopy(run, trigger);
  const pending = actions.pending.get(run.flow_run_id);
  return (
    <TaskActivityRow
      task={{ title: run.flow_name, description, source, projectName: run.project_name }}
      state="neutral"
      trailing={run.held_at ? formatShortTimeAgo(run.held_at) : null}
      onActivate={trigger ? () => onViewTrigger(trigger) : undefined}
      activationStatusLabel="ready to start, show what started it"
      actions={
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="xs"
            loading={pending === 'start'}
            disabled={pending !== undefined}
            aria-label={`Start ${run.flow_name}`}
            onClick={() => actions.start(run)}
          >
            Start
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            loading={pending === 'dismiss'}
            disabled={pending !== undefined}
            aria-label={`Dismiss ${run.flow_name}`}
            onClick={() => actions.dismiss(run)}
          >
            Dismiss
          </Button>
        </div>
      }
    />
  );
}

/** Runs of Flows that ask before running, each waiting for Start or Dismiss, newest first. */
export const Inbox = memo(function Inbox(): ReactElement | null {
  const { runs, total, canLoadOlder, isLoadingOlder, loadOlder } = useHeldRuns();
  const actions = useHeldRunActions();
  const [viewing, setViewing] = useState<TriggerContext | null>(null);
  if (runs.length === 0) return null;
  return (
    <div className="mb-4 shrink-0">
      <TaskActivityList
        ariaLabel="Runs ready to start"
        heading={total > runs.length ? `Inbox, ${total} ready to start` : 'Inbox, ready to start'}
        headingId="work-queue-inbox-heading"
        initialCount={MAX_VISIBLE_HELD_RUNS}
        itemLabel="run ready to start"
        items={runs}
        renderItem={(run) => (
          <HeldRunRow
            key={run.flow_run_id}
            run={run}
            actions={actions}
            onViewTrigger={setViewing}
          />
        )}
      />
      {canLoadOlder && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          loading={isLoadingOlder}
          onClick={loadOlder}
          className="mt-2 text-muted-foreground"
        >
          Load older runs
        </Button>
      )}
      {viewing && (
        <TriggerContentDialog
          open
          onOpenChange={(open) => !open && setViewing(null)}
          triggerContext={viewing}
        />
      )}
    </div>
  );
});
