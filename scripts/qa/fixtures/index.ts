/**
 * Deterministic fixture workspace for qavis QA runs.
 *
 * Every value is fixed — IDs, timestamps, message text — so the rendered UI is
 * identical between the base-ref boot and the head-ref boot of a QA run (and
 * run-over-run). Nondeterministic fixtures would show up as phantom diffs to
 * the vision judge. Keep any content added here boring and stable.
 *
 * Pure data + insert logic only (no bun/electron APIs) so the vitest suite can
 * validate the fixtures against the live schema via freshDb().
 */
import * as schema from '../../../src/main/lib/db/schema';
import { pluginNodeSchemas } from '../../../src/main/lib/db/schema/plugin-installations';
import { syntheticTranscript } from './synthetic-transcript';
import { seedBackgroundWorkFixture } from './background-work';
import { seedCodexFixture } from './codex';
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_CHAT_EMPTY_ID,
  FIXTURE_CHAT_SEEDED_ID,
  FIXTURE_HISTORY_CANCELLED_ID,
  FIXTURE_HISTORY_COMPLETED_ID,
  FIXTURE_LONG_CHAT_ID,
  FIXTURE_LONG_CHAT_NAME,
  FIXTURE_LONG_SUB_CHAT_ID,
  FIXTURE_PROJECT_ID,
  FIXTURE_SUB_CHAT_ID,
  FIXTURE_TASK_ID,
  T0,
  T1,
  T2,
  seedTranscript,
  type SqliteDb,
} from './base';
import { seedInterruptedFlowFixture, seedPausedFlowFixture, seedRunningFlowFixture } from './flows';
import {
  FIXTURE_FLOW_CHAT_ID,
  FIXTURE_FLOW_MESSAGES,
  FIXTURE_FLOW_SUB_CHAT_ID,
  FIXTURE_FLOW_TASK_DONE_ID,
  FIXTURE_FLOW_TASK_PARKED_ID,
  FIXTURE_MESSAGES,
  FIXTURE_PARKED_SIGNAL,
} from './messages';
import { seedPluginNodeFlowFixture } from './plugin-node';
import { seedBatchGroupFixture, seedQueuedAdmissionFixture } from './queue';

/**
 * Insert the fixture workspace: one project (pointing at the checkout under
 * test), an empty chat, and a seeded chat with one sub-chat holding a short
 * user/assistant exchange.
 *
 * DESTRUCTIVE ON PURPOSE: truncates the projects/chats/sub_chats tables before
 * inserting, so the DB ends up with exactly this workspace no matter what it
 * held before — scoped deletes would leave stray rows and break the
 * pixel-determinism the vision judge depends on. Only ever point this at a
 * disposable DB (the wiped QA profile, a temp file, an in-memory test DB) —
 * never at a real agents.db.
 */
export function seedFixtures(db: SqliteDb, projectPath: string, claudeSourcePath: string): void {
  db.delete(schema.tasks).run();
  db.delete(schema.subChatMessages).run();
  db.delete(schema.subChats).run();
  db.delete(schema.chats).run();
  // Flow fixture chain (FK: node_runs → flow_runs → flow_versions → flows) — cleared here so a
  // re-seed stays idempotent; these tables are not truncated anywhere else.
  db.delete(schema.nodeRuns).run();
  db.delete(schema.flowRunAdmissions).run();
  db.delete(schema.flowRuns).run();
  db.delete(schema.flowVersions).run();
  db.delete(schema.flows).run();
  db.delete(pluginNodeSchemas).run();
  db.delete(schema.projects).run();
  db.delete(schema.claudeCodeCredentials).run();

  // Passthrough accounts need no stored token, but every resolution probes sourcePath: without one
  // the first resolution flags the row and the composer gives way to the reconnect card. Claude
  // stays the workspace default; the Codex fixture overrides only its own project.
  db.insert(schema.claudeCodeCredentials)
    .values({
      id: FIXTURE_ACCOUNT_ID,
      type: 'claude-code',
      accountLabel: 'QA Claude',
      oauthToken: null,
      source: 'claude-passthrough',
      sourcePath: claudeSourcePath,
      needsReauthAt: null,
      isDefault: true,
      connectedAt: T0,
    })
    .run();

  db.insert(schema.projects)
    .values({
      id: FIXTURE_PROJECT_ID,
      name: 'QA Fixture',
      path: projectPath,
      createdAt: T0,
      updatedAt: T0,
    })
    .run();

  // A task linked to the seeded chat, so deleting that chat opens the destructive task-aware
  // confirmation dialog (the red "Stop task + delete" button — the surface a11y/contrast QA needs
  // to judge).
  //
  // Status is 'plan_ready', NOT 'running', on purpose: recoverOrphanedTasks() (db/repos/tasks.ts,
  // run at every boot from src/main/index.ts) flips orphaned 'running' tasks to 'cancelled', which
  // would drop this task out of the sidebar's active set before the run ever reaches it. 'plan_ready'
  // survives that sweep, is in SIDEBAR_STOPPABLE_TASK_STATUSES so the sidebar treats it as active
  // (dialog fires), and is never auto-executed — the task poller only claims status='pending', so
  // the fixture stays deterministic (no real agent run is ever spawned for it).
  {
    db.insert(schema.tasks)
      .values({
        id: FIXTURE_TASK_ID,
        projectId: FIXTURE_PROJECT_ID,
        description:
          'Seeded QA task (plan ready) — its linked chat opens the destructive delete dialog.',
        source: 'qa-fixture',
        status: 'plan_ready',
        executionTarget: 'local',
        createdAt: T1,
      })
      .run();

    db.insert(schema.tasks)
      .values([
        {
          id: FIXTURE_HISTORY_COMPLETED_ID,
          projectId: FIXTURE_PROJECT_ID,
          title: 'Completed history example',
          description: 'Shipped successfully from the QA fixture.',
          source: 'qa-fixture',
          status: 'completed',
          executionTarget: 'local',
          createdAt: T2,
          completedAt: T2,
        },
        {
          id: FIXTURE_HISTORY_CANCELLED_ID,
          projectId: FIXTURE_PROJECT_ID,
          title: 'Cancelled history example',
          description: 'Stopped intentionally in the QA fixture.',
          source: 'qa-fixture',
          status: 'cancelled',
          executionTarget: 'local',
          createdAt: T1,
        },
      ])
      .run();
  }

  db.insert(schema.chats)
    .values([
      {
        id: FIXTURE_CHAT_EMPTY_ID,
        name: 'Empty chat',
        projectId: FIXTURE_PROJECT_ID,
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: FIXTURE_CHAT_SEEDED_ID,
        name: 'Flow changes — 7 applied',
        projectId: FIXTURE_PROJECT_ID,
        // Link to the seeded task so this chat's delete is task-aware (destructive confirm dialog).
        taskId: FIXTURE_TASK_ID,
        createdAt: T1,
        updatedAt: T1,
      },
      {
        id: FIXTURE_LONG_CHAT_ID,
        name: FIXTURE_LONG_CHAT_NAME,
        projectId: FIXTURE_PROJECT_ID,
        createdAt: T0,
        updatedAt: T0,
      },
    ])
    .run();

  db.insert(schema.subChats)
    .values([
      {
        id: FIXTURE_SUB_CHAT_ID,
        name: 'Flow changes — 7 applied',
        chatId: FIXTURE_CHAT_SEEDED_ID,
        mode: 'agent',
        createdAt: T1,
        updatedAt: T1,
      },
      {
        id: FIXTURE_LONG_SUB_CHAT_ID,
        name: FIXTURE_LONG_CHAT_NAME,
        chatId: FIXTURE_LONG_CHAT_ID,
        mode: 'agent',
        createdAt: T0,
        updatedAt: T0,
      },
    ])
    .run();
  seedTranscript(db, FIXTURE_SUB_CHAT_ID, FIXTURE_MESSAGES);
  seedTranscript(
    db,
    FIXTURE_LONG_SUB_CHAT_ID,
    syntheticTranscript({ messages: 24, bytesPerAssistantMessage: 400_000 }),
  );

  // Multi-node flow parked at awaiting_input (see the FIXTURE_FLOW_* note above). The
  // parked-question card resolves the driving task by sub-chat. Tasks first (the chat's taskId FK
  // points at the done one), then the chat, then its sub-chat.
  db.insert(schema.tasks)
    .values([
      {
        id: FIXTURE_FLOW_TASK_DONE_ID,
        projectId: FIXTURE_PROJECT_ID,
        description: 'Seeded QA flow — first node (complete).',
        source: 'flow',
        status: 'done',
        executionTarget: 'local',
        result: {
          subChatId: FIXTURE_FLOW_SUB_CHAT_ID,
          agentSignal: {
            state: 'done',
            summary: 'First node complete.',
            at: '2026-01-01T11:30:00.000Z',
          },
        },
        createdAt: T1,
      },
      {
        id: FIXTURE_FLOW_TASK_PARKED_ID,
        projectId: FIXTURE_PROJECT_ID,
        description: 'Seeded QA flow — later node awaiting your input.',
        source: 'flow',
        status: 'needs_attention',
        executionTarget: 'local',
        result: { subChatId: FIXTURE_FLOW_SUB_CHAT_ID, agentSignal: FIXTURE_PARKED_SIGNAL },
        // Newest non-terminal task on the sub-chat → the DRIVING task getFlowDriveInfoForSubChat picks.
        createdAt: T2,
      },
    ])
    .run();

  db.insert(schema.chats)
    .values({
      id: FIXTURE_FLOW_CHAT_ID,
      name: 'Awaiting input flow',
      projectId: FIXTURE_PROJECT_ID,
      // Pinned to the DONE first node (terminal): the exact bug scenario. The reader must NOT read
      // this pinned task — it must resolve the driving needs_attention task from the sub-chat.
      taskId: FIXTURE_FLOW_TASK_DONE_ID,
      createdAt: T1,
      updatedAt: T2,
    })
    .run();

  db.insert(schema.subChats)
    .values({
      id: FIXTURE_FLOW_SUB_CHAT_ID,
      name: 'Awaiting input flow',
      chatId: FIXTURE_FLOW_CHAT_ID,
      mode: 'agent',
      createdAt: T1,
      updatedAt: T2,
    })
    .run();
  seedTranscript(db, FIXTURE_FLOW_SUB_CHAT_ID, FIXTURE_FLOW_MESSAGES);

  seedPausedFlowFixture(db);
  seedRunningFlowFixture(db);
  seedInterruptedFlowFixture(db);
  seedPluginNodeFlowFixture(db);
  seedQueuedAdmissionFixture(db);
  seedBatchGroupFixture(db);
  seedCodexFixture(db, projectPath);
  seedBackgroundWorkFixture(db, FIXTURE_PROJECT_ID, FIXTURE_ACCOUNT_ID);
}

export * from './base';
export * from './messages';
export * from './flows';
export * from './plugin-node';
export * from './queue';
export * from './verify';
