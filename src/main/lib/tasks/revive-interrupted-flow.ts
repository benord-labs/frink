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
    const { sessionAnsweredTaskNode } = await import('../flows/rerun/session-resume');
    const db = getDatabase();
    // A follow-up continues the node only if the session ever answered its prompt; otherwise the
    // agent's next `done` would complete a node it never received. The run stays on Re-run.
    if (!(await sessionAnsweredTaskNode(db, subChatId, taskId))) {
      log.info('[Socket Executor] in-place revive declined: node never answered', {
        subChatId,
        flowRunId,
      });
      return;
    }
    const { reviveInPlaceCommand } = await import('../flows/transitions');
    const { commitUnpark } = await import('../flows/rerun/unpark-node-run');
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
