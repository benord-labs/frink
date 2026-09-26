import { captureException } from '@sentry/electron/renderer';
import { toast } from 'sonner';
import { trpcClient } from '@/lib/trpc';

/**
 * Result shape from batch file operations.
 */
type BatchResult = {
  success: boolean;
  error?: string;
};

/** One entry of a `batchMoveFiles` result. */
export type MoveResult = {
  sourcePath: string;
  destPath?: string;
  success: boolean;
};

/** What a batch file operation did, phrased for the success toast. */
type BatchAction = 'Moved' | 'Trashed';

/** Maps past-tense action to present-tense verb for error messages */
const ACTION_VERBS: Record<BatchAction, string> = {
  // biome-ignore lint/style/useNamingConvention: PascalCase keys match action string literals
  Moved: 'move',
  // biome-ignore lint/style/useNamingConvention: PascalCase keys match action string literals
  Trashed: 'trash',
};

/** How long an undoable toast stays on screen before the chance to undo lapses. */
export const UNDO_TOAST_DURATION_MS = 10_000;

/** "1 item" / "3 items" — single-item batches are the common case here. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Show appropriate toast feedback for a batch operation result.
 * Handles success, partial failure, and full failure cases.
 *
 * `undo` is offered only alongside a success — there is nothing to reverse when
 * every item failed.
 */
export function showBatchResultToast(
  action: BatchAction,
  results: BatchResult[],
  undo?: () => Promise<void>,
): void {
  const failures = results.filter((r) => !r.success);
  const successes = results.filter((r) => r.success);
  const undoAction = undo ? { label: 'Undo', onClick: () => void undo() } : undefined;
  const undoable = undoAction && { duration: UNDO_TOAST_DURATION_MS, action: undoAction };

  if (failures.length > 0 && successes.length > 0) {
    toast.warning(
      `${action} ${plural(successes.length, 'item')}, ${failures.length} failed`,
      undoable,
    );
  } else if (failures.length > 0 && successes.length === 0) {
    toast.error(`Failed to ${ACTION_VERBS[action]} ${plural(failures.length, 'item')}`);
  } else if (successes.length > 0) {
    toast.success(`${action} ${plural(successes.length, 'item')}`, undoable);
  }
}

/**
 * Build the Undo callback for a same-project batch move, or `undefined` when
 * there is nothing to reverse (so the caller shows no Undo button).
 *
 * Items are reversed independently: a batch where only some items can go back
 * — because something reoccupied an original path meanwhile — still restores
 * the rest and says so, rather than failing as a whole.
 */
export function buildBatchMoveUndo(opts: {
  projectPath: string;
  results: MoveResult[];
  onUndone: () => void;
}): (() => Promise<void>) | undefined {
  // No destPath means nothing actually moved (source was already in the
  // destination), so there is nothing to undo for that item.
  const moved = opts.results.flatMap((r) =>
    r.success && r.destPath ? [{ sourcePath: r.sourcePath, destPath: r.destPath }] : [],
  );
  if (moved.length === 0) return undefined;

  return async () => {
    const outcomes = await Promise.allSettled(
      moved.map((item) =>
        trpcClient.files.undoFileMove.mutate({
          sourceProjectPath: opts.projectPath,
          sourcePath: item.sourcePath,
          destProjectPath: opts.projectPath,
          destPath: item.destPath,
        }),
      ),
    );

    opts.onUndone();
    reportUndoOutcome(outcomes, moved.length);
  };
}

/**
 * Report how much of an undo actually landed. Shared by same-project and
 * cross-project undo so a partial reversal reads the same either way.
 *
 * Takes the settled results rather than a count: a per-item reversal that fails
 * is shown to the user only as a smaller number, so the reasons are captured
 * here or they are lost.
 */
export function reportUndoOutcome(outcomes: PromiseSettledResult<unknown>[], total: number): void {
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      captureException(outcome.reason, { tags: { area: 'files-undo-move' } });
    }
  }

  const undone = outcomes.filter((o) => o.status === 'fulfilled').length;
  if (undone === total) toast.success(`Undid ${plural(undone, 'move')}`);
  else if (undone === 0) toast.error('Undo failed');
  else toast.warning(`Undid ${undone} of ${plural(total, 'move')}`);
}

/** Feedback for a batch trash, which is never undoable in-app. */
export function showTrashToast(results: BatchResult[]): void {
  showBatchResultToast('Trashed', results);
}

/**
 * Success feedback for a batch move, with Undo wired in — the whole
 * post-move toast in one call, since all three file trees need it identically.
 */
export function showMoveToast(
  projectPath: string,
  results: MoveResult[],
  onUndone: () => void,
): void {
  showBatchResultToast('Moved', results, buildBatchMoveUndo({ projectPath, results, onUndone }));
}

/**
 * Run a batch mutation with a loading toast.
 * Shows a loading spinner, then dismisses it on success (the mutation's own
 * `onSuccess` handler should provide detailed feedback via `showBatchResultToast`).
 * On catastrophic error (network/transport), replaces the loading toast with an error.
 */
export function mutateWithLoadingToast<TInput>(opts: {
  mutate: (
    input: TInput,
    options?: { onSettled?: (_data: unknown, error: unknown) => void },
  ) => void;
  input: TInput;
  loadingMessage: string;
  errorMessage: string;
}): void {
  const toastId = toast.loading(opts.loadingMessage);
  opts.mutate(opts.input, {
    onSettled: (_data, error) => {
      if (error) {
        toast.error(opts.errorMessage, { id: toastId });
      } else {
        toast.dismiss(toastId);
      }
    },
  });
}
