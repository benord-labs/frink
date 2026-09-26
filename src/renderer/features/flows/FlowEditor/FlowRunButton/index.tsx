/**
 * The Flow editor's Run button. Presentational: the parent computes the batch run-state and owns the
 * start mutation. Renders one of:
 * - plain "Run" (no batch — single manual run),
 * - "Start Batch" / "Run batch" (a batch defined but never run),
 * - a disabled "Running…" (a run in flight),
 * - a disabled recovery notice for a terminal batch.
 */

import { Button } from '@benord-labs/frink-primitives';
import { Loader2, Play } from 'lucide-react';
import type { ReactElement } from 'react';
import type { BatchRunState } from '../../../../lib/utils/batch-run-state';

type Props = {
  /** null = no batch (plain single run). */
  runState: BatchRunState | null;
  /** A never-run batch whose root stages are still deferred → "Start Batch" rather than "Run batch". */
  isBatchDeferred: boolean;
  disabled: boolean;
  isPending: boolean;
  /** Start a single run / start (or advance) the batch — the `start` and no-batch paths. */
  onPrimaryStart: () => void;
};

const spinner = <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />;

type StartRunPrimary = 'start' | 'running' | 'unavailable' | undefined;

const PRIMARY_TITLE: Partial<Record<Exclude<StartRunPrimary, undefined>, string>> = {
  running: 'Batch is running',
  unavailable: 'This batch already has runs — use Retry or Carry on above, per run',
};

function startRunLabel(primary: StartRunPrimary, isBatchDeferred: boolean): string {
  if (primary === undefined) return 'Run';
  if (primary === 'unavailable') return 'Batch already ran';
  return isBatchDeferred ? 'Start Batch' : 'Run batch';
}

/** The plain "Run" / "Start Batch" / "Run batch" / disabled-"Running…" button (no re-run modes). */
function StartRunButton({
  primary,
  isBatchDeferred,
  disabled,
  isPending,
  onClick,
}: {
  primary: StartRunPrimary;
  isBatchDeferred: boolean;
  disabled: boolean;
  isPending: boolean;
  onClick: () => void;
}): ReactElement {
  const running = primary === 'running';
  const unavailable = primary === 'unavailable';
  const busy = isPending || running;
  const label = startRunLabel(primary, isBatchDeferred);
  return (
    <>
      {/* The disabled button drops out of the a11y tree, so announce the in-flight state. */}
      {running && (
        <span role="status" className="sr-only">
          Batch is running
        </span>
      )}
      {unavailable && (
        <span role="status" className="sr-only">
          This batch already has runs. Use Retry or Carry on for each run above — there is no
          whole-batch recovery.
        </span>
      )}
      <Button
        type="button"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        disabled={disabled || busy || unavailable}
        title={primary ? PRIMARY_TITLE[primary] : undefined}
        onClick={onClick}
      >
        {busy ? spinner : <Play className="h-3.5 w-3.5" aria-hidden />}
        {running ? 'Running…' : label}
      </Button>
    </>
  );
}

export function FlowRunButton({
  runState,
  isBatchDeferred,
  disabled,
  isPending,
  onPrimaryStart,
}: Props): ReactElement {
  const primary = runState?.primary;
  return (
    <StartRunButton
      primary={primary}
      isBatchDeferred={isBatchDeferred}
      disabled={disabled}
      isPending={isPending}
      onClick={onPrimaryStart}
    />
  );
}
