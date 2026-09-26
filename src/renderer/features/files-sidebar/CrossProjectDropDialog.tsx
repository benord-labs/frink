/* eslint-disable max-lines, max-lines-per-function */
/**
 * Confirmation dialog shown when a file/folder is dragged between
 * two different projects in split view.
 *
 * Supports single-item and batch (multi-select) operations.
 * Batch operations use dedicated mutations with per-item conflict resolution.
 *
 * NOTE: We intentionally use the shared <Button> component instead of
 * <AlertDialogAction> because Radix's AlertDialogAction auto-closes
 * the dialog on click. We need the dialog to stay open while the
 * mutation is in-flight so we can show errors / conflict UI inline.
 */

import { Button } from '@benord-labs/frink-primitives';
import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { trpc, trpcClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { reportUndoOutcome, UNDO_TOAST_DURATION_MS } from './utils/batch-result-toasts';

/* ── Conflict resolution helpers ── */

const RESOLUTION_OPTIONS: ConflictResolution[] = ['overwrite', 'keepBoth', 'skip'];

const RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  overwrite: 'Replace',
  keepBoth: 'Keep Both',
  skip: 'Skip',
};

/** Segmented button group for picking a conflict resolution */
const ResolutionPicker = ({
  value,
  onChange,
  size = 'sm',
}: {
  value?: ConflictResolution | null;
  onChange: (res: ConflictResolution) => void;
  size?: 'sm' | 'md';
}) => (
  <div className="relative flex shrink-0 rounded-md border border-border">
    {RESOLUTION_OPTIONS.map((res, i) => (
      <Button
        key={res}
        variant="ghost"
        size="sm"
        onClick={() => onChange(res)}
        className={cn(
          'h-auto rounded-none',
          size === 'md' ? 'px-3 py-1.5 text-xs' : 'px-2.5 py-1 text-xs',
          i === 0 && 'rounded-l-[5px]',
          i === RESOLUTION_OPTIONS.length - 1 && 'rounded-r-[5px]',
          i < RESOLUTION_OPTIONS.length - 1 && 'border-r border-border',
          value === res
            ? 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary'
            : 'text-muted-foreground',
        )}
      >
        {RESOLUTION_LABELS[res]}
      </Button>
    ))}
  </div>
);

export type CrossProjectDropInfo = {
  /** Relative path of the dragged item inside its source project */
  sourcePath: string;
  /** Display name of the dragged item */
  sourceName: string;
  /** Absolute project path of the source */
  sourceProjectPath: string;
  /** Absolute project path of the destination */
  destProjectPath: string;
  /** Relative folder path inside destination project (empty = root) */
  destFolder: string;
  /** All items being transferred (primary + batch). Falls back to single item. */
  items?: Array<{ path: string; name: string; type: 'file' | 'folder' }>;
};

type CrossProjectDropDialogProps = {
  /** When non-null the dialog is open with the given drop info */
  dropInfo: CrossProjectDropInfo | null;
  /** Called after the dialog closes (regardless of outcome) */
  onClose: () => void;
};

/** Check if an error message indicates a file-exists conflict */
function isConflictError(message: string): boolean {
  return message.includes('already exists at destination');
}

/** Conflict info from batch operations */
type BatchConflict = {
  path: string;
  name: string;
};

type ConflictResolution = 'overwrite' | 'keepBoth' | 'skip';

export function CrossProjectDropDialog({ dropInfo, onClose }: CrossProjectDropDialogProps) {
  const utils = trpc.useUtils();

  // Determine if this is a batch operation
  const allItems = useMemo(() => {
    if (!dropInfo) return [];
    if (dropInfo.items && dropInfo.items.length > 1) return dropInfo.items;
    return [{ path: dropInfo.sourcePath, name: dropInfo.sourceName, type: 'file' as const }];
  }, [dropInfo]);
  const isBatch = allItems.length > 1;

  // --- Shared state ---
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<'copy' | 'move' | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    currentFile: string;
  } | null>(null);
  const operationIdRef = useRef<string | null>(null);

  // --- Batch conflict state ---
  const [batchConflicts, setBatchConflicts] = useState<BatchConflict[]>([]);
  const [batchErrors, setBatchErrors] = useState<Array<{ path: string; error: string }>>([]);
  /** Per-item resolution map */
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({});
  /** "Apply to all" resolution */
  const [applyToAll, setApplyToAll] = useState<ConflictResolution | null>(null);

  // Reset state when dropInfo changes (new dialog open)
  useEffect(() => {
    if (dropInfo) {
      setError(null);
      setLastAction(null);
      setIsPending(false);
      setProgress(null);
      setBatchConflicts([]);
      setBatchErrors([]);
      setResolutions({});
      setApplyToAll(null);
      operationIdRef.current = null;
    }
  }, [dropInfo]);

  // Subscribe to progress events from the main process
  useEffect(() => {
    const unsub = window.desktopApi?.onFileOperationProgress?.((p) => {
      if (operationIdRef.current && p.operationId === operationIdRef.current) {
        if (p.done) {
          setProgress(null);
        } else {
          setProgress({ current: p.current, total: p.total, currentFile: p.currentFile });
        }
      }
    });
    return () => unsub?.();
  }, []);

  // ---- Single-item undo toast ----
  const showUndoToast = useCallback(
    (
      name: string,
      variables: { sourceProjectPath: string; sourcePath: string; destProjectPath: string },
      destPath: string,
    ) => {
      toast.success(`Moved "${name}"`, {
        duration: UNDO_TOAST_DURATION_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            trpcClient.files.undoFileMove
              .mutate({
                sourceProjectPath: variables.sourceProjectPath,
                sourcePath: variables.sourcePath,
                destProjectPath: variables.destProjectPath,
                destPath,
              })
              .then(() => {
                toast.success('Move undone');
                utils.files.listDirectory.invalidate();
              })
              .catch((err: Error) => {
                toast.error(`Undo failed: ${err.message}`);
              });
          },
        },
      });
    },
    [utils.files.listDirectory],
  );

  // ---- Batch undo toast ----
  const showBatchUndoToast = useCallback(
    (
      movedItems: Array<{ sourcePath: string; destPath: string }>,
      sourceProjectPath: string,
      destProjectPath: string,
    ) => {
      const count = movedItems.length;
      toast.success(`Moved ${count} item${count > 1 ? 's' : ''}`, {
        duration: UNDO_TOAST_DURATION_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            // allSettled, not all: a batch where only some items can go back
            // still restores the rest instead of reporting a total failure.
            Promise.allSettled(
              movedItems.map((item) =>
                trpcClient.files.undoFileMove.mutate({
                  sourceProjectPath,
                  sourcePath: item.sourcePath,
                  destProjectPath,
                  destPath: item.destPath,
                }),
              ),
            ).then((outcomes) => {
              utils.files.listDirectory.invalidate();
              reportUndoOutcome(outcomes, count);
            });
          },
        },
      });
    },
    [utils.files.listDirectory],
  );

  // ---- Single-item mutation (existing behavior) ----
  const executeSingleMutation = useCallback(
    async (action: 'copy' | 'move', opts?: { overwrite?: boolean; keepBoth?: boolean }) => {
      if (!dropInfo) return;

      const opId = crypto.randomUUID();
      operationIdRef.current = opId;

      const input = {
        sourceProjectPath: dropInfo.sourceProjectPath,
        sourcePath: dropInfo.sourcePath,
        destProjectPath: dropInfo.destProjectPath,
        destFolder: dropInfo.destFolder,
        operationId: opId,
        ...(opts?.overwrite && { overwrite: true }),
        ...(opts?.keepBoth && { keepBoth: true }),
      };

      setError(null);
      setLastAction(action);
      setIsPending(true);

      try {
        if (action === 'copy') {
          await trpcClient.files.crossProjectCopy.mutate(input);
          const name = dropInfo.sourcePath.split('/').pop() ?? dropInfo.sourcePath;
          toast.success(`Copied "${name}" successfully`);
        } else {
          const result = await trpcClient.files.crossProjectMove.mutate(input);
          const name = dropInfo.sourcePath.split('/').pop() ?? dropInfo.sourcePath;
          showUndoToast(name, input, result.destPath);
        }

        utils.files.listDirectory.invalidate();
        onClose();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Operation failed';
        setError(message);
      } finally {
        setIsPending(false);
        setProgress(null);
      }
    },
    [dropInfo, onClose, showUndoToast, utils.files.listDirectory],
  );

  // ---- Batch mutation ----
  const executeBatchMutation = useCallback(
    async (action: 'copy' | 'move', resolveMap?: Record<string, ConflictResolution>) => {
      if (!dropInfo) return;

      const opId = crypto.randomUUID();
      operationIdRef.current = opId;

      const sourcePaths = allItems.map((item) => item.path);
      const input = {
        sourceProjectPath: dropInfo.sourceProjectPath,
        sourcePaths,
        destProjectPath: dropInfo.destProjectPath,
        destFolder: dropInfo.destFolder,
        operationId: opId,
        ...(resolveMap && Object.keys(resolveMap).length > 0 && { resolutions: resolveMap }),
      };

      setError(null);
      setLastAction(action);
      setIsPending(true);
      setBatchConflicts([]);
      setBatchErrors([]);

      try {
        if (action === 'copy') {
          const result = await trpcClient.files.batchCrossProjectCopy.mutate(input);
          if (result.conflicts.length > 0) {
            setBatchConflicts(result.conflicts);
            if (result.errors.length > 0) setBatchErrors(result.errors);
            return; // Stay open for resolution
          }
          if (result.errors.length > 0) {
            setBatchErrors(result.errors);
            if (result.completed.length > 0) {
              toast.warning(
                `Copied ${result.completed.length} item${result.completed.length > 1 ? 's' : ''}, ${result.errors.length} failed`,
              );
            } else {
              toast.error(
                `${result.errors.length} item${result.errors.length > 1 ? 's' : ''} failed to copy`,
              );
            }
          } else if (result.completed.length > 0) {
            toast.success(
              `Copied ${result.completed.length} item${result.completed.length > 1 ? 's' : ''}`,
            );
          } else {
            toast('No items were copied');
          }
        } else {
          const result = await trpcClient.files.batchCrossProjectMove.mutate(input);
          if (result.conflicts.length > 0) {
            setBatchConflicts(result.conflicts);
            if (result.errors.length > 0) setBatchErrors(result.errors);
            return; // Stay open for resolution
          }
          if (result.errors.length > 0) {
            setBatchErrors(result.errors);
            if (result.completed.length > 0) {
              toast.warning(
                `Moved ${result.completed.length} item${result.completed.length > 1 ? 's' : ''}, ${result.errors.length} failed`,
              );
            } else {
              toast.error(
                `${result.errors.length} item${result.errors.length > 1 ? 's' : ''} failed to move`,
              );
            }
          } else if (result.completed.length > 0) {
            showBatchUndoToast(
              result.completed,
              dropInfo.sourceProjectPath,
              dropInfo.destProjectPath,
            );
          } else {
            toast('No items were moved');
          }
        }

        utils.files.listDirectory.invalidate();
        onClose();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Operation failed';
        setError(message);
      } finally {
        setIsPending(false);
        setProgress(null);
      }
    },
    [dropInfo, allItems, onClose, showBatchUndoToast, utils.files.listDirectory],
  );

  // ---- Dispatch: single vs batch ----
  const handleCopy = useCallback(
    (opts?: { overwrite?: boolean; keepBoth?: boolean }) => {
      if (isBatch) executeBatchMutation('copy');
      else executeSingleMutation('copy', opts);
    },
    [isBatch, executeBatchMutation, executeSingleMutation],
  );

  const handleMove = useCallback(
    (opts?: { overwrite?: boolean; keepBoth?: boolean }) => {
      if (isBatch) executeBatchMutation('move');
      else executeSingleMutation('move', opts);
    },
    [isBatch, executeBatchMutation, executeSingleMutation],
  );

  /** Resolve single-item conflict (existing behavior) */
  const handleResolveConflict = useCallback(
    (strategy: 'overwrite' | 'keepBoth') => {
      const opts = strategy === 'overwrite' ? { overwrite: true } : { keepBoth: true };
      if (lastAction === 'copy') executeSingleMutation('copy', opts);
      else if (lastAction === 'move') executeSingleMutation('move', opts);
    },
    [lastAction, executeSingleMutation],
  );

  /** Submit batch conflicts with the resolution map */
  const handleBatchConflictSubmit = useCallback(() => {
    // Build the resolution map
    const resolveMap: Record<string, ConflictResolution> = {};
    for (const conflict of batchConflicts) {
      resolveMap[conflict.path] = applyToAll ?? resolutions[conflict.path] ?? 'skip';
    }
    if (lastAction) executeBatchMutation(lastAction, resolveMap);
  }, [batchConflicts, resolutions, applyToAll, lastAction, executeBatchMutation]);

  /** Set per-item resolution */
  const setItemResolution = useCallback((path: string, resolution: ConflictResolution) => {
    setApplyToAll(null); // Clear "apply to all" when individual is set
    setResolutions((prev) => ({ ...prev, [path]: resolution }));
  }, []);

  /** Apply the same resolution to all conflicts */
  const handleApplyToAll = useCallback((resolution: ConflictResolution) => {
    setApplyToAll(resolution);
  }, []);

  /** Re-run the last action with same params (generic retry) */
  const handleRetry = useCallback(() => {
    if (isBatch) {
      if (lastAction) executeBatchMutation(lastAction);
    } else {
      if (lastAction === 'copy') executeSingleMutation('copy');
      else if (lastAction === 'move') executeSingleMutation('move');
    }
  }, [lastAction, isBatch, executeBatchMutation, executeSingleMutation]);

  /** Cancel an in-progress operation */
  const handleCancel = useCallback(() => {
    if (operationIdRef.current) {
      trpcClient.files.crossProjectCancelOperation
        .mutate({ operationId: operationIdRef.current })
        .catch(() => {});
    }
    setIsPending(false);
    setProgress(null);
    setError(null);
    onClose();
  }, [onClose]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isPending) handleCancel();
        else onClose();
        return;
      }

      if (isPending || batchConflicts.length > 0) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const key = e.key.toLowerCase();

      if (error && isConflictError(error)) {
        if (key === 'r') {
          e.preventDefault();
          handleResolveConflict('overwrite');
        } else if (key === 'k') {
          e.preventDefault();
          handleResolveConflict('keepBoth');
        }
      } else if (!error) {
        if (key === 'c') {
          e.preventDefault();
          handleCopy();
        } else if (key === 'm') {
          e.preventDefault();
          handleMove();
        }
      }
    },
    [
      isPending,
      error,
      batchConflicts.length,
      handleCopy,
      handleMove,
      handleResolveConflict,
      handleCancel,
      onClose,
    ],
  );

  const destProjectName = dropInfo?.destProjectPath.split('/').pop() ?? 'project';
  const hasConflict = !isBatch && error !== null && isConflictError(error);
  const hasBatchConflicts = batchConflicts.length > 0;
  const hasGenericError = error !== null && !hasConflict && !hasBatchConflicts;

  const itemCount = allItems.length;

  return (
    <AlertDialog open={!!dropInfo} onOpenChange={(open) => !open && !isPending && onClose()}>
      <AlertDialogContent
        onKeyDown={handleKeyDown}
        className={hasBatchConflicts ? 'max-w-xl' : undefined}
      >
        <AlertDialogHeader>
          {hasBatchConflicts ? (
            <>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
                {batchConflicts.length} conflict{batchConflicts.length > 1 ? 's' : ''} found
              </AlertDialogTitle>
              <AlertDialogDescription>
                Some items already exist in{' '}
                <span className="font-medium text-foreground">{destProjectName}</span>. Choose how
                to handle each conflict.
              </AlertDialogDescription>
            </>
          ) : hasConflict ? (
            <>
              <AlertDialogTitle>
                &ldquo;{dropInfo?.sourceName}&rdquo; already exists in {destProjectName}
              </AlertDialogTitle>
              <AlertDialogDescription>
                A file or folder with this name already exists at the destination. What would you
                like to do?
              </AlertDialogDescription>
            </>
          ) : (
            <>
              <AlertDialogTitle>
                {isBatch
                  ? `Copy or move ${itemCount} items to ${destProjectName}?`
                  : `Copy or move to ${destProjectName}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isBatch ? (
                  <>
                    Would you like to copy or move{' '}
                    <span className="font-medium text-foreground">{itemCount} items</span> to{' '}
                    <span className="font-medium text-foreground">{destProjectName}</span>?
                  </>
                ) : (
                  <>
                    Would you like to copy or move{' '}
                    <span className="font-medium text-foreground">{dropInfo?.sourceName}</span> to{' '}
                    <span className="font-medium text-foreground">{destProjectName}</span>?
                  </>
                )}
              </AlertDialogDescription>
            </>
          )}
        </AlertDialogHeader>

        {/* Batch item list (initial view) */}
        {isBatch && !hasBatchConflicts && !isPending && !error && allItems.length <= 10 && (
          <div className="mx-5 max-h-32 overflow-y-auto rounded-md border border-border/50 p-2 text-xs text-muted-foreground space-y-0.5">
            {allItems.map((item) => (
              <div key={item.path} className="truncate">
                {item.name}
              </div>
            ))}
          </div>
        )}

        {/* Progress indicator */}
        {progress && (
          <output className="block space-y-1.5 px-5" aria-live="polite">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {lastAction === 'move' ? 'Moving' : 'Copying'} {progress.current} of{' '}
                {progress.total} {isBatch ? 'items' : 'files'}&hellip;
              </span>
              <span className="tabular-nums">
                {Math.round((progress.current / progress.total) * 100)}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={Math.round((progress.current / progress.total) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${lastAction === 'move' ? 'Moving' : 'Copying'} files`}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-150 motion-reduce:transition-none"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
            <p className="truncate text-xs text-muted-foreground">{progress.currentFile}</p>
          </output>
        )}

        {/* Batch conflict resolution UI */}
        {hasBatchConflicts && (
          <div className="mx-5 space-y-3">
            {/* Apply to all bar */}
            <div className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-3 py-2.5">
              <span className="text-xs font-medium text-muted-foreground">Apply to all:</span>
              <ResolutionPicker value={applyToAll} onChange={handleApplyToAll} size="md" />
            </div>

            {/* Per-item conflict list */}
            <div className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {batchConflicts.map((conflict) => {
                const resolved = applyToAll ?? resolutions[conflict.path];
                return (
                  <div
                    key={conflict.path}
                    className={cn(
                      'flex items-center justify-between gap-3 px-3 py-2.5 transition-colors',
                      resolved && 'bg-card/30',
                    )}
                  >
                    <span
                      className={cn(
                        'min-w-0 truncate text-sm',
                        resolved ? 'text-foreground' : 'text-muted-foreground',
                      )}
                      title={conflict.path}
                    >
                      {conflict.name}
                    </span>
                    <ResolutionPicker
                      value={resolved}
                      onChange={(res) => setItemResolution(conflict.path, res)}
                    />
                  </div>
                );
              })}
            </div>

            {/* Batch errors */}
            {batchErrors.length > 0 && (
              <div
                role="alert"
                className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {batchErrors.length} item{batchErrors.length > 1 ? 's' : ''} failed
              </div>
            )}
          </div>
        )}

        {/* Generic error message (non-conflict) */}
        {hasGenericError && (
          <div
            role="alert"
            className="mx-5 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <AlertDialogFooter>
          {isPending ? (
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
          ) : hasBatchConflicts ? (
            <>
              <AlertDialogCancel
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                }}
              >
                Cancel
              </AlertDialogCancel>
              <Button
                onClick={handleBatchConflictSubmit}
                disabled={!applyToAll && batchConflicts.some((c) => !resolutions[c.path])}
              >
                Continue
              </Button>
            </>
          ) : hasConflict ? (
            <>
              <AlertDialogCancel
                disabled={isPending}
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                }}
              >
                Cancel
              </AlertDialogCancel>
              <Button
                onClick={() => handleResolveConflict('keepBoth')}
                disabled={isPending}
                aria-keyshortcuts="k"
              >
                <span className="mr-1 text-xs text-muted-foreground">[K]</span>
                Keep Both
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleResolveConflict('overwrite')}
                disabled={isPending}
                aria-keyshortcuts="r"
              >
                <span className="mr-1 text-xs text-muted-foreground">[R]</span>
                Replace
              </Button>
            </>
          ) : (
            <>
              <AlertDialogCancel
                disabled={isPending}
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                }}
              >
                Cancel
              </AlertDialogCancel>
              {hasGenericError ? (
                <Button onClick={handleRetry} disabled={isPending}>
                  Try Again
                </Button>
              ) : (
                <>
                  <Button
                    onClick={() => handleCopy()}
                    disabled={isPending}
                    aria-keyshortcuts="c"
                    autoFocus
                  >
                    <span className="mr-1 text-xs text-muted-foreground">[C]</span>
                    Copy{isBatch ? ` ${itemCount}` : ''}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => handleMove()}
                    disabled={isPending}
                    aria-keyshortcuts="m"
                  >
                    <span className="mr-1 text-xs text-muted-foreground">[M]</span>
                    Move{isBatch ? ` ${itemCount}` : ''}
                  </Button>
                </>
              )}
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
