import log from 'electron-log';

/** Revive a restart-interrupted flow task for a chat follow-up: task, marked node and run go back to
 * `running` in one transaction, or nothing changes. The follow-up turn itself drives the work. */
export async function reviveRestartInterruptedFlow(
  taskId: string,
  flowRunId: string,
  subChatId: string,
): Promise<void> {
  try {
    // Dynamic imports keep the db/flows graph off the executor's static import chain.
    const { getDatabase } = await import('../db');
    const { reviveInPlaceCommand } = await import('../flows/transitions');
    const { commitUnpark } = await import('../flows/rerun/unpark-node-run');
    const db = getDatabase();
    const revived = await commitUnpark(
      flowRunId,
      () => reviveInPlaceCommand(db, taskId, flowRunId),
      taskId,
    );
    if (!revived) log.info('[Socket Executor] in-place revive declined', { subChatId, flowRunId });
  } catch (err) {
    // The follow-up turn still runs; a revive that never committed leaves Re-run available.
    log.warn('[Socket Executor] in-place revive failed', {
      subChatId,
      flowRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    const { captureFlowAdmissionException } = await import('../flows/admission/activity');
    captureFlowAdmissionException(err, 'revive-unpark');
  }
}
