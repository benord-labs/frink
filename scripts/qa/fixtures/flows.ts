/** Flow-chat fixtures (paused, running, restart-interrupted) and the one seeder they share. */
import * as schema from '../../../src/main/lib/db/schema';
import { RESTART_INTERRUPTION_REASON } from '../../../src/shared/types/flow';
import { FIXTURE_PROJECT_ID, T0, T1, T2, T3, seedTranscript, type SqliteDb } from './base';

// A user-PAUSED flow on its own sub-chat: an active flow_run(paused) + a needs_attention driving task
// marked userPause, carrying the running node's model + mode in triggerContext._config. Opening this
// chat renders FlowPausedBar's read-only model/mode readout — the SAME pills the running strip shows
// (a static 'running' task can't survive recoverOrphanedTasks; a needs_attention user-pause task can).
// flow → flow_version → flow_run → task is an FK chain, so the seed clears + re-inserts those tables.
export const FIXTURE_QUEUED_FLOW_ID = 'qa-fixture-flow-queued';
export const FIXTURE_QUEUED_FLOW_VERSION_ID = 'qa-fixture-flow-queued-version';
export const FIXTURE_QUEUED_START_RUN_ID = 'qa-fixture-flow-run-queued-start';
export const FIXTURE_QUEUED_RESUME_RUN_ID = 'qa-fixture-flow-run-queued-resume';
export const FIXTURE_PAUSED_FLOW_ID = 'qa-fixture-flow-paused';
export const FIXTURE_PAUSED_FLOW_VERSION_ID = 'qa-fixture-flow-paused-version';
export const FIXTURE_PAUSED_RUN_ID = 'qa-fixture-flow-paused-run';
export const FIXTURE_PAUSED_TASK_ID = 'qa-fixture-flow-paused-task';
export const FIXTURE_PAUSED_CHAT_ID = 'qa-fixture-chat-flow-paused';
export const FIXTURE_PAUSED_SUB_CHAT_ID = 'qa-fixture-subchat-flow-paused';
/** Picker id the pill renders as "Opus 4.8 · Max" (the id encodes the Max effort tier). */
export const FIXTURE_PAUSED_MODEL_ID = 'opus-4.8-max';

// A RUNNING flow on its own sub-chat: an active flow_run + a `done` driving task (NOT userPause, NOT
// needs_attention), which deriveFlowChatBottomSurface resolves to the RUNNING strip — the "terminal
// task of the node that just finished / taskless window" case, the only running-strip state a static
// fixture can hold. A `running` task or `running` flow_run can't be used: the boot sweeps
// (recoverOrphanedTasks → cancelled, recoverOrphans → failed) terminalize both, and a cancelled task
// under a live run derives to the composer. So the run is `paused` (survives, and only supplies
// liveness — the surface is TASK-derived, mirroring the paused fixture that renders a different
// surface off the same run status) and the task is `done`. canPause is false here (no `running`
// task), exactly as in a real taskless window, so the strip shows the status line + model/mode pills
// + Add-a-note (→ FlowReplyBox) + Stop, but no Pause — the reachable-by-QA half of the strip.
export const FIXTURE_RUNNING_FLOW_ID = 'qa-fixture-flow-running';
export const FIXTURE_RUNNING_FLOW_VERSION_ID = 'qa-fixture-flow-running-version';
export const FIXTURE_RUNNING_RUN_ID = 'qa-fixture-flow-running-run';
export const FIXTURE_RUNNING_TASK_ID = 'qa-fixture-flow-running-task';
export const FIXTURE_RUNNING_CHAT_ID = 'qa-fixture-chat-flow-running';
export const FIXTURE_RUNNING_SUB_CHAT_ID = 'qa-fixture-subchat-flow-running';
/** Picker id the pill renders as "Sonnet 5 · High" — distinct from the paused fixture's Opus. */
export const FIXTURE_RUNNING_MODEL_ID = 'sonnet-5';

// A restart-INTERRUPTED flow: the only state that renders InterruptedRunControls, and the one no
// amount of clicking can reach — it exists solely as the residue of a process that died mid-node.
// Four rows have to agree or the row silently stays hidden:
//   flow_run  cancelled + trigger_context.chatId (the ONLY chat link getLatestFlowRunForChat reads
//             here — the paused fixture's subChatId link is invisible to it);
//   node_run  cancelled carrying RESTART_INTERRUPTION_REASON — the marker is what separates a
//             recoverable interruption from a deliberate Stop, which renders nothing;
//   task      cancelled, source='flow', result.subChatId — how the mode probe finds the driving task;
//   sub_chat  a sessionId, so the run is session-resumable; its continuation ticket is seeded
//             queued (seedInterruptedFlowFixture), so the row shows the waiting copy, no button.
// Every row is already terminal, so the boot sweeps (recoverOrphaned{Tasks,FlowRuns,NodeRuns}) leave
// it untouched — the state is inert and identical on the base and head boots of a QA run.
// One object, not eight flat consts: these ids are consumed as a UNIT by seedFlowChatFixture's spec,
// and a ninth repetitive `export const FIXTURE_…_ID` line is what tipped this constants block into a
// duplicate of the block above it. `sessionId` is any non-null value — the app never dials it.
export const FIXTURE_INTERRUPTED = {
  flowId: 'qa-fixture-flow-interrupted',
  versionId: 'qa-fixture-flow-interrupted-version',
  runId: 'qa-fixture-flow-interrupted-run',
  nodeRunId: 'qa-fixture-flow-interrupted-node-run',
  taskId: 'qa-fixture-flow-interrupted-task',
  chatId: 'qa-fixture-chat-flow-interrupted',
  subChatId: 'qa-fixture-subchat-flow-interrupted',
  sessionId: 'qa-fixture-interrupted-session',
} as const;

/** Messages for the paused sub-chat — a short exchange ending as the flow parks for review. */
const FIXTURE_PAUSED_MESSAGES = [
  {
    id: 'qa-fixture-paused-msg-user-1',
    role: 'user',
    parts: [{ type: 'text', text: 'Plan the refactor before changing anything.' }],
  },
  {
    id: 'qa-fixture-paused-msg-assistant-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Paused for your review — resume when you are ready.' }],
  },
];

/** Minimal valid flow graph (FlowPausedBar reads none of it — only the schema's NOT NULL json). */
export const FIXTURE_PAUSED_GRAPH = {
  nodes: [{ id: 'agent-1', type: 'agent', data: { label: 'Implement the feature' } }],
  edges: [],
  settings: {},
};

/**
 * ENGINE-shaped graph (blockType/config), unlike the paused fixture's ReactFlow-shaped stub, which
 * no surface ever reads. This one is dispatchable: the interrupted fixture is the only one offering
 * a control that re-runs a node, and the engine resolves the node's blockType from here to write the
 * new node_run. A stub graph makes that INSERT fail on node_runs.block_type NOT NULL — a QA-only
 * error that reads exactly like a product bug. `agent-1` must match the seeded node_run's nodeId.
 */
const FIXTURE_INTERRUPTED_GRAPH = {
  nodes: [
    {
      id: 'agent-1',
      blockType: 'agent',
      label: 'Migrate the settings screen',
      config: { instructions: 'Migrate the settings screen to the new form primitives.' },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  settings: {},
};

/**
 * Messages for the interrupted sub-chat — an exchange that stops mid-sentence, which is what a
 * process killed mid-turn actually leaves behind. The cut-off assistant line is the visual cue the
 * QA judge needs: the transcript ends without a conclusion, and the row above the composer is the
 * only way to continue it.
 */
const FIXTURE_INTERRUPTED_MESSAGES = [
  {
    id: 'qa-fixture-interrupted-msg-user-1',
    role: 'user',
    parts: [{ type: 'text', text: 'Migrate the settings screen to the new form primitives.' }],
  },
  {
    id: 'qa-fixture-interrupted-msg-assistant-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Converting the first three fields — starting with the' }],
  },
];

/** Messages for the running sub-chat — a short exchange while the flow is mid-run. */
const FIXTURE_RUNNING_MESSAGES = [
  {
    id: 'qa-fixture-running-msg-user-1',
    role: 'user',
    parts: [{ type: 'text', text: 'Add a health-check endpoint and wire it into the router.' }],
  },
  {
    id: 'qa-fixture-running-msg-assistant-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'On it — adding the route and a smoke test now.' }],
  },
];

/**
 * Minimal valid graph. FlowRunStrip polls flows.getRun for a `running` node_run to label the status
 * line; none is seeded (a running node_run is swept to failed at boot too), so the label falls back
 * to the generic "Flow running…" — the honest taskless-window state.
 */
const FIXTURE_RUNNING_GRAPH = {
  nodes: [{ id: 'agent-1', type: 'agent', data: { label: 'Add the endpoint' } }],
  edges: [],
  settings: {},
};

/**
 * One flow-chat fixture chain, parent-first: flow → flow_version → flow_run → task → chat →
 * sub_chat. All three flow fixtures (paused / running / interrupted) are the SAME six inserts with
 * different constants, so they share this seeder — a third hand-rolled copy is what the duplication
 * gate (rightly) refused. Each caller supplies only what actually distinguishes its surface.
 *
 * `runTriggerContext` differs per fixture on purpose: the paused/running runs link to their SUB-chat
 * (getActiveFlowRunForSubChat), the interrupted run to its CHAT (getLatestFlowRunForChat). Passing
 * it verbatim keeps that difference visible at the call site rather than buried in a flag.
 */
type FlowChatFixture = {
  flowId: string;
  versionId: string;
  runId: string;
  taskId: string;
  chatId: string;
  subChatId: string;
  flowName: string;
  chatName: string;
  graph: unknown;
  runStatus: 'paused' | 'cancelled';
  runTriggerContext: Record<string, unknown>;
  taskDescription: string;
  taskStatus: 'needs_attention' | 'done' | 'cancelled';
  taskTriggerContext: Record<string, unknown>;
  taskResult: Record<string, unknown>;
  mode: string;
  messages: readonly unknown[];
  /** Present only where a resumable Claude session is part of the state under test. */
  sessionId?: string;
  /** Terminal fixtures stamp completedAt on the run + task, as a real terminal write does. */
  completedAt?: Date;
  /** Sidebar ordering; the interrupted fixture uses T3 so its chat sorts first. */
  updatedAt: Date;
};

function seedFlowChatFixture(db: SqliteDb, f: FlowChatFixture): void {
  db.insert(schema.flows)
    .values({
      id: f.flowId,
      projectId: FIXTURE_PROJECT_ID,
      name: f.flowName,
      createdAt: T0,
      updatedAt: f.updatedAt,
    })
    .run();
  db.insert(schema.flowVersions)
    .values({
      id: f.versionId,
      flowId: f.flowId,
      versionNumber: 1,
      graph: f.graph,
      createdAt: T0,
    })
    .run();
  db.insert(schema.flowRuns)
    .values({
      id: f.runId,
      flowVersionId: f.versionId,
      status: f.runStatus,
      triggerContext: f.runTriggerContext,
      createdAt: T2,
      ...(f.completedAt ? { completedAt: f.completedAt } : {}),
    })
    .run();
  db.insert(schema.tasks)
    .values({
      id: f.taskId,
      projectId: FIXTURE_PROJECT_ID,
      description: f.taskDescription,
      source: 'flow',
      status: f.taskStatus,
      executionTarget: 'local',
      flowRunId: f.runId,
      triggerContext: f.taskTriggerContext,
      result: f.taskResult,
      createdAt: T2,
      ...(f.completedAt ? { completedAt: f.completedAt } : {}),
    })
    .run();
  db.insert(schema.chats)
    .values({
      id: f.chatId,
      name: f.chatName,
      projectId: FIXTURE_PROJECT_ID,
      taskId: f.taskId,
      createdAt: T1,
      updatedAt: f.updatedAt,
    })
    .run();
  db.insert(schema.subChats)
    .values({
      id: f.subChatId,
      name: f.chatName,
      chatId: f.chatId,
      mode: f.mode,
      createdAt: T1,
      updatedAt: f.updatedAt,
      ...(f.sessionId ? { sessionId: f.sessionId } : {}),
    })
    .run();
  seedTranscript(db, f.subChatId, f.messages);
}

/**
 * User-PAUSED: the task's `userPause` marker + `_config` make deriveFlowChatBottomSurface resolve
 * `paused` with modelId/mode, so the chat renders FlowPausedBar's readout.
 */
export function seedPausedFlowFixture(db: SqliteDb): void {
  seedFlowChatFixture(db, {
    flowId: FIXTURE_PAUSED_FLOW_ID,
    versionId: FIXTURE_PAUSED_FLOW_VERSION_ID,
    runId: FIXTURE_PAUSED_RUN_ID,
    taskId: FIXTURE_PAUSED_TASK_ID,
    chatId: FIXTURE_PAUSED_CHAT_ID,
    subChatId: FIXTURE_PAUSED_SUB_CHAT_ID,
    flowName: 'Paused QA flow',
    chatName: 'Paused flow',
    graph: FIXTURE_PAUSED_GRAPH,
    runStatus: 'paused',
    runTriggerContext: { subChatId: FIXTURE_PAUSED_SUB_CHAT_ID },
    taskDescription: 'Seeded QA flow — paused, awaiting your resume.',
    taskStatus: 'needs_attention',
    taskTriggerContext: { _config: { model: FIXTURE_PAUSED_MODEL_ID, startMode: 'plan' } },
    taskResult: {
      subChatId: FIXTURE_PAUSED_SUB_CHAT_ID,
      userPause: { at: '2026-01-01T12:00:00.000Z' },
    },
    mode: 'plan',
    messages: FIXTURE_PAUSED_MESSAGES,
    updatedAt: T2,
  });
}

/**
 * RESTART-INTERRUPTED. See the FIXTURE_INTERRUPTED_* block for why each row is load-bearing; the
 * node_run below is the extra one this fixture alone needs — the marker on it is what separates a
 * recoverable interruption from a deliberate Stop.
 */
export function seedInterruptedFlowFixture(db: SqliteDb): void {
  seedFlowChatFixture(db, {
    flowId: FIXTURE_INTERRUPTED.flowId,
    versionId: FIXTURE_INTERRUPTED.versionId,
    runId: FIXTURE_INTERRUPTED.runId,
    taskId: FIXTURE_INTERRUPTED.taskId,
    chatId: FIXTURE_INTERRUPTED.chatId,
    subChatId: FIXTURE_INTERRUPTED.subChatId,
    flowName: 'Interrupted QA flow',
    chatName: 'Interrupted flow',
    graph: FIXTURE_INTERRUPTED_GRAPH,
    runStatus: 'cancelled',
    // chatId, not subChatId: getLatestFlowRunForChat resolves the row's run through this link.
    runTriggerContext: { chatId: FIXTURE_INTERRUPTED.chatId },
    taskDescription: 'Seeded QA flow — interrupted by a restart, resumable in place.',
    taskStatus: 'cancelled',
    taskTriggerContext: { _config: { model: FIXTURE_RUNNING_MODEL_ID, startMode: 'agent' } },
    // The cancel path MERGES its marker, so a real interrupted task keeps its subChatId linkage.
    taskResult: {
      subChatId: FIXTURE_INTERRUPTED.subChatId,
      cancelled: true,
      error: RESTART_INTERRUPTION_REASON,
    },
    mode: 'agent',
    messages: FIXTURE_INTERRUPTED_MESSAGES,
    sessionId: FIXTURE_INTERRUPTED.sessionId,
    completedAt: T2,
    updatedAt: T3,
  });
  db.insert(schema.nodeRuns)
    .values({
      id: FIXTURE_INTERRUPTED.nodeRunId,
      flowRunId: FIXTURE_INTERRUPTED.runId,
      nodeId: 'agent-1',
      blockType: 'agent',
      status: 'cancelled',
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
      startedAt: T2,
      completedAt: T2,
      createdAt: T2,
    })
    .run();
  // Its resume ticket is queued behind the cap (the rig freezes drains), which is the state the
  // chat renders as "Queued to resume this step…" instead of a Continue or Retry button.
  db.insert(schema.flowRunAdmissions)
    .values({
      flowRunId: FIXTURE_INTERRUPTED.runId,
      state: 'queued',
      priorityClass: 'resume',
      intentVersion: 1,
      intentJson: {
        version: 1,
        action: 'resume',
        flow_run_id: FIXTURE_INTERRUPTED.runId,
        node_run_id: FIXTURE_INTERRUPTED.nodeRunId,
      },
      requestedAt: T3,
    })
    .run();
}

/**
 * RUNNING: a `done` driving task under a live run, which deriveFlowChatBottomSurface resolves to the
 * running strip. See the FIXTURE_RUNNING_* block for why `done`/`paused` (not `running`) is required.
 */
export function seedRunningFlowFixture(db: SqliteDb): void {
  seedFlowChatFixture(db, {
    flowId: FIXTURE_RUNNING_FLOW_ID,
    versionId: FIXTURE_RUNNING_FLOW_VERSION_ID,
    runId: FIXTURE_RUNNING_RUN_ID,
    taskId: FIXTURE_RUNNING_TASK_ID,
    chatId: FIXTURE_RUNNING_CHAT_ID,
    subChatId: FIXTURE_RUNNING_SUB_CHAT_ID,
    flowName: 'Running QA flow',
    chatName: 'Running flow',
    graph: FIXTURE_RUNNING_GRAPH,
    runStatus: 'paused',
    runTriggerContext: { subChatId: FIXTURE_RUNNING_SUB_CHAT_ID },
    taskDescription: 'Seeded QA flow — running.',
    taskStatus: 'done',
    taskTriggerContext: { _config: { model: FIXTURE_RUNNING_MODEL_ID, startMode: 'agent' } },
    taskResult: { subChatId: FIXTURE_RUNNING_SUB_CHAT_ID },
    mode: 'agent',
    messages: FIXTURE_RUNNING_MESSAGES,
    updatedAt: T2,
  });
}
