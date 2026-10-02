import { ipcMain } from 'electron';
import log from 'electron-log';
import type { SocketPermissionResponsePayload } from '../../../../shared/types/permissions';
import { getDatabase } from '../../db';
import { captureMainException } from '../../sentry/init';
import { onExecuteRequest, onStop, sendPermissionResponse } from '../../socket';
import { handleRemoteExecute, handleRemoteStop } from '../../socket/executor';
import { registerAttachmentProtocol } from '../attachments-protocol';

/**
 * Boot recovery sweeps + local background loops, run once from the ready path; every step is best-effort and only logs on failure.
 * Order matters: the batch listener precedes the flow/task recovery sweep + task-completion watcher so no terminal event fires unobserved, and the worktree sweep follows them so in-flight-on-boot work has settled.
 */
export async function runStartupRecoveryAndLoops(): Promise<void> {
  const step = async (label: string, run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (err) {
      log.warn(`[Main] ${label} failed:`, err);
    }
  };

  // Local turn dispatch plus the renderer's approve/deny return path. Registered before any
  // window exists so an early permission answer always finds a listener.
  await step('local dispatch listeners register', () => {
    // Long agents intentionally have no wall-clock timeout; runtime-gate.ts handles concurrency
    // and restart reaps orphans. See decision `agent-execution-wall-clock`.
    onExecuteRequest((payload) => {
      void handleRemoteExecute(payload).catch((error) => {
        payload.onExecutionStarted?.(
          error instanceof Error ? error : new Error('Chat execution failed.'),
        );
        captureMainException(error, { surface: 'remote-execute-handler' });
      });
    });
    onStop((payload) => {
      handleRemoteStop(payload);
    });
    ipcMain.on(
      'socket:permission-response',
      (_event: Electron.IpcMainEvent, response: SocketPermissionResponsePayload) => {
        sendPermissionResponse(response);
      },
    );
  });

  // Advance batch stages on run-terminal events.
  await step('flows batch advance listener start', async () => {
    const { startBatchAdvanceListener } = await import('../batch-dispatch');
    startBatchAdvanceListener();
  });

  // A question still HELD when the process died parks first: the sweeps below would otherwise
  // cancel its run and boot carry-on would resume the agent without it.
  await step('flows park held questions', async () => {
    const { parkQuestionsHeldAtShutdown } = await import('./held-question-recovery');
    parkQuestionsHeldAtShutdown(getDatabase());
  });
  // node_run / flow_run rows still 'running' from a prior process are marked cancelled (a restart).
  await step('flows recoverOrphans', async () => {
    const { recoverOrphans } = await import('../scheduler');
    await recoverOrphans();
  });
  await step('tasks recoverOrphanedTasks', async () => {
    const { recoverInterruptedFlowTasks } =
      await import('../admission/terminal-resume/boot-continuation');
    await recoverInterruptedFlowTasks(getDatabase());
  });
  await step('flows recover admissions', async () => {
    const { recoverFlowAdmissionsAtStartup } = await import('../admission/startup');
    await recoverFlowAdmissionsAtStartup();
  });

  // Worktree recovery sweep: prune stale git registrations + remove worktrees no active chat
  // references (the guaranteed backstop for fire-and-forget teardown failures).
  await step('recoverOrphanedWorktrees', async () => {
    const { recoverOrphanedWorktrees } = await import('../../trpc/routers/chats/teardown-worktree');
    const { resolveWorktreeBasePath } = await import('../../worktree/base-path-config');
    const { pruned, removed, skipped, orphaned } = await recoverOrphanedWorktrees(
      getDatabase(),
      await resolveWorktreeBasePath(),
    );
    if ([pruned, removed, skipped, orphaned].some((count) => count > 0)) {
      log.info('[Main] recoverOrphanedWorktrees reclaimed', { pruned, removed, skipped, orphaned });
    }
  });

  // Custom protocol behind the frink-attachment:// URLs the renderer's <img src> consumes.
  await step('flows attachment protocol register', () => registerAttachmentProtocol());

  // Sweep orphaned attachment directories whose batch_stage_run was cascade-deleted.
  await step('flows attachments sweep', async () => {
    const { sweepOrphanedAttachments } = await import('../attachments-cleanup');
    await sweepOrphanedAttachments();
  });
  await step('integrations plugin connect unwind', async () => {
    const { unwindUnconnectedInstalls } = await import('../../integrations');
    await unwindUnconnectedInstalls(getDatabase());
  });
  // Network discovery runs in the background; cached nodes and startup remain usable.
  void step('integrations missing node schemas', async () => {
    const cache = await import('../../integrations/plugin-node-derivation/schema-cache');
    await cache.refreshMissingPluginNodeSchemas();
  });

  // Fires flow runs whose first node's cron matches the current UTC minute.
  await step('flows schedule loop start', async () => {
    const { startScheduleTriggerLoop } = await import('../schedule-trigger');
    startScheduleTriggerLoop();
  });

  // Forward flowEventBus events to every BrowserWindow on socket:flow-execution-event.
  await step('flows event bridge start', async () => {
    const { startFlowEventBridge } = await import('../event-bridge');
    startFlowEventBridge();
  });

  // Poll terminal flow-linked tasks → advanceFlowRun, resuming the engine once the task
  // poller + handleClaimedTask + Claude SDK session finish via the renderer.
  await step('flows task completion watcher start', async () => {
    const { startTaskCompletionWatcher } = await import('../task-completion-watcher');
    startTaskCompletionWatcher();
  });

  // Accepts signed webhook deliveries on 127.0.0.1 and starts the Flows they match.
  // A port clash logs and leaves the rest of boot alone.
  await step('webhooks loopback ingress start', async () => {
    const { startWebhookIngress } = await import('../../webhooks');
    await startWebhookIngress();
  });

  // Claims this machine's addresses from the relay named by FRINK_WEBHOOK_BASE_URL, so a delivery
  // from the internet reaches it too. No variable set leaves the loopback listener on its own.
  await step('webhooks relay client start', async () => {
    const { startWebhookRelayClient } = await import('../../webhooks');
    startWebhookRelayClient();
  });

  // Poll terminal tasks → fan out post_task_trigger flow_trigger_bindings. Replaces
  // cross-machine flow/dispatch-node fan-out for single-machine local mode. Triggers migration T4.
  await step('flows post-task-trigger loop start', async () => {
    const { startPostTaskTriggerLoop } = await import('../post-task-trigger');
    startPostTaskTriggerLoop();
  });
}
