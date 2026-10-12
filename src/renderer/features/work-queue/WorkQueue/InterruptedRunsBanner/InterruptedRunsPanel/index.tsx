import { Button } from '@benord-labs/frink-primitives';
import { RotateCcw } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type {
  BulkRecoverOutcome,
  BulkRecoverResult,
  RecoveryKind,
} from '../../../../../../shared/types/flow-run/resume';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../../components/ui/alert-dialog';

/** One row of tasks.interruptedRuns. */
export type InterruptedRun = {
  taskId: string;
  flowRunId: string;
  projectId: string | null;
  projectName: string | null;
  description: string;
  recoveryKind: RecoveryKind;
  confirmSideEffects: boolean;
  recoveryNodeRunId?: string;
};

export type RecoverItem = { taskId: string; kind: RecoveryKind; recoveryNodeRunId?: string };

type Props = {
  runs: readonly InterruptedRun[];
  /** Recovers the confirmed runs; null when the batch failed as a whole (already reported). */
  onContinueAll: (items: RecoverItem[]) => Promise<BulkRecoverResult[] | null>;
};

const ALL_PROJECTS = '__all__';
const NO_PROJECT = '__none__';

const OUTCOME_LABEL = {
  resumed: 'Resumed',
  queued: 'Queued',
  'already-queued': 'Already queued',
  refused: 'Not recovered',
  'needs-confirmation': 'Needs its own confirm',
} satisfies Record<BulkRecoverOutcome, string>;

const projectKey = (run: InterruptedRun) => run.projectId ?? NO_PROJECT;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function projectScopes(runs: readonly InterruptedRun[]) {
  const scopes = new Map<string, { label: string; count: number }>();
  for (const run of runs) {
    const key = projectKey(run);
    const scope = scopes.get(key) ?? { label: run.projectName ?? 'No project', count: 0 };
    scope.count += 1;
    scopes.set(key, scope);
  }
  return [...scopes.entries()];
}

/** The runs the dialog would act on, split by whether they recover in bulk. */
function planFor(runs: readonly InterruptedRun[], scope: string) {
  const scoped = scope === ALL_PROJECTS ? runs : runs.filter((run) => projectKey(run) === scope);
  const toRecover = scoped.filter((run) => !run.confirmSideEffects);
  return {
    toRecover,
    toConfirm: scoped.filter((run) => run.confirmSideEffects),
    continues: toRecover.filter((run) => run.recoveryKind === 'continue').length,
  };
}

const toItem = (run: InterruptedRun): RecoverItem => ({
  taskId: run.taskId,
  kind: run.recoveryKind,
  recoveryNodeRunId: run.recoveryNodeRunId,
});

/**
 * Leads the Overview while a restart has left Flow runs interrupted, with one action that applies
 * each run's own Continue or Retry. A started non-agent step is listed, never re-run from here.
 */
export function InterruptedRunsPanel({ runs, onContinueAll }: Props): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [scope, setScope] = useState(ALL_PROJECTS);
  const [results, setResults] = useState<BulkRecoverResult[] | null>(null);
  // Taken when the batch is sent: the list refetches without the runs it recovered.
  const [sentNames, setSentNames] = useState<ReadonlyMap<string, string>>(new Map());

  if (runs.length === 0 && !open) return null;
  const plan = planFor(runs, scope);

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (next) return;
    setResults(null);
    setScope(ALL_PROJECTS);
  };
  const handleContinueAll = async () => {
    setSentNames(new Map(plan.toRecover.map((run) => [run.taskId, run.description])));
    setPending(true);
    try {
      const recovered = await onContinueAll(plan.toRecover.map(toItem));
      if (recovered) setResults(recovered);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {runs.length > 0 && (
        <InterruptedRunsStatus count={runs.length} onOpen={() => setOpen(true)} />
      )}
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent className="w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {results ? 'Interrupted runs recovered' : 'Continue all interrupted runs?'}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody className="space-y-3">
            {results ? (
              <RecoveryResults results={results} names={sentNames} />
            ) : (
              <RecoveryPlan runs={runs} plan={plan} scope={scope} onScope={setScope} />
            )}
          </AlertDialogBody>
          <AlertDialogFooter>
            {results ? (
              <AlertDialogCancel>Done</AlertDialogCancel>
            ) : (
              <>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <Button
                  type="button"
                  onClick={() => void handleContinueAll()}
                  disabled={plan.toRecover.length === 0 || pending}
                  loading={pending}
                >
                  Continue {plural(plan.toRecover.length, 'run')}
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function InterruptedRunsStatus({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}): ReactElement {
  return (
    <div
      role="status"
      className="glass-card mb-4 flex shrink-0 items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5"
    >
      <span className="activity-row-leading flex size-9 shrink-0 items-center justify-center rounded-[10px] text-warning-fg">
        <RotateCcw className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-ink">
          {plural(count, 'Flow run')} interrupted by a restart
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-fg">
          Each continues where its session left off, or retries its step if nothing started.
        </span>
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 shrink-0 border-border/50 px-2 text-xs"
        onClick={onOpen}
      >
        Continue all
      </Button>
    </div>
  );
}

function RecoveryResults({
  results,
  names,
}: {
  results: readonly BulkRecoverResult[];
  names: ReadonlyMap<string, string>;
}): ReactElement {
  return (
    <ul aria-label="Recovery results" className="max-h-64 space-y-1.5 overflow-y-auto">
      {results.map((result) => (
        <li key={result.taskId} className="text-xs">
          <span className="font-medium text-ink">{names.get(result.taskId) ?? result.taskId}</span>
          <span className="text-muted-fg">
            {' '}
            — {OUTCOME_LABEL[result.outcome]}
            {result.reason ? `: ${result.reason}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RecoveryPlan({
  runs,
  plan,
  scope,
  onScope,
}: {
  runs: readonly InterruptedRun[];
  plan: ReturnType<typeof planFor>;
  scope: string;
  onScope: (scope: string) => void;
}): ReactElement {
  const { toRecover, toConfirm, continues } = plan;
  return (
    <>
      <ProjectScopes runs={runs} scope={scope} onScope={onScope} />
      <AlertDialogDescription className="space-y-2">
        <span className="block">
          {toRecover.length === 0
            ? 'No run here can be recovered in bulk.'
            : `Recover ${plural(toRecover.length, 'run')}: ${continues} continue in their session, ${toRecover.length - continues} retry their step.`}
        </span>
        <span className="block text-muted-foreground">
          Resumes go ahead of queued starts, then wait their turn behind the run limit.
        </span>
      </AlertDialogDescription>
      {toConfirm.length > 0 && (
        <div className="text-xs">
          <span className="block font-medium text-ink">
            Needs individual confirmation ({toConfirm.length})
          </span>
          <span className="mb-1 block text-muted-fg">
            Their step had started and may repeat what it did. Retry each from its row.
          </span>
          <ul aria-label="Needs individual confirmation" className="space-y-1">
            {toConfirm.map((run) => (
              <li key={run.taskId} className="truncate text-muted-fg">
                {run.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ProjectScopes({
  runs,
  scope,
  onScope,
}: {
  runs: readonly InterruptedRun[];
  scope: string;
  onScope: (scope: string) => void;
}): ReactElement | null {
  const scopes = projectScopes(runs);
  if (scopes.length < 2) return null;
  return (
    <div role="group" aria-label="Projects" className="flex flex-wrap gap-1.5">
      <ScopeButton
        active={scope === ALL_PROJECTS}
        label={`All projects (${runs.length})`}
        onSelect={() => onScope(ALL_PROJECTS)}
      />
      {scopes.map(([key, { label, count }]) => (
        <ScopeButton
          key={key}
          active={scope === key}
          label={`${label} (${count})`}
          onSelect={() => onScope(key)}
        />
      ))}
    </div>
  );
}

function ScopeButton({
  active,
  label,
  onSelect,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant={active ? 'secondary' : 'ghost'}
      size="xs"
      aria-pressed={active}
      onClick={onSelect}
    >
      {label}
    </Button>
  );
}
