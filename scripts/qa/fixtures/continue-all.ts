/**
 * Restart-interrupted runs holding no resume ticket: the Work Queue's Continue all banner lists only
 * these (the interrupted fixture's run has a queued ticket, so the banner leaves it out). One per
 * recovery the dialog sorts into: Continue (its session answered), Retry (never answered), a started
 * non-agent step it never re-runs, and a run in the QA Codex project so the project scope shows.
 */
import * as schema from '../../../src/main/lib/db/schema';
import { isRestartInterrupted } from '../../../src/main/lib/flows/transitions';
import { RESTART_INTERRUPTION_REASON } from '../../../src/shared/types/flow';
import { FIXTURE_PROJECT_ID, seedTranscript, T0, T1, type SqliteDb } from './base';
import { CODEX_FIXTURE } from './codex';

type InterruptedStep = { nodeId: string; blockType: 'agent' | 'run_command'; label: string };

type ContinueAllRun = {
  key: string;
  flowName: string;
  projectId: string;
  /** The step the restart cut off. */
  step: InterruptedStep;
  /** An agent step that finished before it, whose task stands in for the run (non-agent steps). */
  done?: InterruptedStep;
  /** Its session answered the step's prompt, so it reads Continue rather than Retry. */
  answered: boolean;
  at: Date;
};

export const CONTINUE_ALL_RUNS: readonly ContinueAllRun[] = [
  {
    key: 'docs',
    flowName: 'Nightly docs sync',
    projectId: FIXTURE_PROJECT_ID,
    step: { nodeId: 'write-docs', blockType: 'agent', label: 'Update the API docs' },
    answered: false,
    at: new Date('2026-01-01T12:10:00Z'),
  },
  {
    key: 'changelog',
    flowName: 'Changelog draft',
    projectId: FIXTURE_PROJECT_ID,
    step: { nodeId: 'draft', blockType: 'agent', label: 'Draft the changelog' },
    answered: true,
    at: new Date('2026-01-01T12:20:00Z'),
  },
  {
    key: 'deploy',
    flowName: 'Deploy preview',
    projectId: FIXTURE_PROJECT_ID,
    step: { nodeId: 'deploy', blockType: 'run_command', label: 'Deploy the preview' },
    done: { nodeId: 'build', blockType: 'agent', label: 'Build the preview' },
    answered: false,
    at: new Date('2026-01-01T12:30:00Z'),
  },
  {
    key: 'deps',
    flowName: 'Weekly dependency bump',
    projectId: CODEX_FIXTURE.projectId,
    step: { nodeId: 'bump', blockType: 'agent', label: 'Bump the dependencies' },
    answered: false,
    at: new Date('2026-01-01T12:40:00Z'),
  },
];

export const continueAllIds = (key: string) => ({
  flowId: `qa-fixture-continue-all-${key}-flow`,
  versionId: `qa-fixture-continue-all-${key}-version`,
  runId: `qa-fixture-continue-all-${key}-run`,
  nodeRunId: `qa-fixture-continue-all-${key}-node-run`,
  doneNodeRunId: `qa-fixture-continue-all-${key}-done-node-run`,
  taskId: `qa-fixture-continue-all-${key}-task`,
  chatId: `qa-fixture-chat-continue-all-${key}`,
  subChatId: `qa-fixture-subchat-continue-all-${key}`,
});

/** Engine-shaped, so a Continue all click can resolve and re-dispatch the interrupted step. */
function graphFor(run: ContinueAllRun) {
  const steps = run.done ? [run.done, run.step] : [run.step];
  return {
    nodes: steps.map((s, i) => ({
      id: s.nodeId,
      blockType: s.blockType,
      label: s.label,
      config: s.blockType === 'agent' ? { instructions: s.label } : { command: 'echo deploy' },
      position: { x: 0, y: i * 120 },
    })),
    edges: run.done
      ? [{ id: `${run.key}-e1`, source: run.done.nodeId, target: run.step.nodeId }]
      : [],
    settings: {},
  };
}

const MARKER_OUTPUT = {
  status: 'cancelled',
  outputs: {},
  artifacts: [],
  durationMs: 0,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
};

function seedRunRows(db: SqliteDb, run: ContinueAllRun): void {
  const ids = continueAllIds(run.key);
  db.insert(schema.flows)
    .values({
      id: ids.flowId,
      projectId: run.projectId,
      name: run.flowName,
      createdAt: T0,
      updatedAt: run.at,
    })
    .run();
  db.insert(schema.flowVersions)
    .values({
      id: ids.versionId,
      flowId: ids.flowId,
      versionNumber: 1,
      graph: graphFor(run),
      createdAt: T0,
    })
    .run();
  db.insert(schema.flowRuns)
    .values({
      id: ids.runId,
      flowVersionId: ids.versionId,
      status: 'cancelled',
      triggerContext: { chatId: ids.chatId },
      startedAt: run.at,
      completedAt: run.at,
      createdAt: run.at,
    })
    .run();
  if (run.done) {
    db.insert(schema.nodeRuns)
      .values({
        id: ids.doneNodeRunId,
        flowRunId: ids.runId,
        nodeId: run.done.nodeId,
        blockType: run.done.blockType,
        status: 'completed',
        nodeOutput: { status: 'completed', outputs: {}, artifacts: [], durationMs: 0 },
        startedAt: T1,
        completedAt: T1,
        createdAt: T1,
      })
      .run();
  }
  db.insert(schema.nodeRuns)
    .values({
      id: ids.nodeRunId,
      flowRunId: ids.runId,
      nodeId: run.step.nodeId,
      blockType: run.step.blockType,
      status: 'cancelled',
      nodeOutput: MARKER_OUTPUT,
      // Started: a non-agent step that had begun is the one Continue all never re-runs.
      startedAt: run.at,
      completedAt: run.at,
      createdAt: run.at,
    })
    .run();
}

/** The run's task: the interrupted agent step's, or the finished agent step's before a non-agent one. */
function seedRunTask(db: SqliteDb, run: ContinueAllRun): void {
  const ids = continueAllIds(run.key);
  const nodeRunId = run.done ? ids.doneNodeRunId : ids.nodeRunId;
  const linkage = { chatId: ids.chatId, subChatId: ids.subChatId };
  db.insert(schema.tasks)
    .values({
      id: ids.taskId,
      projectId: run.projectId,
      description: `${run.flowName} — ${(run.done ?? run.step).label.toLowerCase()}`,
      source: 'flow',
      status: run.done ? 'done' : 'cancelled',
      executionTarget: 'local',
      flowRunId: ids.runId,
      sourceId: nodeRunId,
      nodeRunId,
      result: run.done
        ? linkage
        : { ...linkage, cancelled: true, error: RESTART_INTERRUPTION_REASON },
      createdAt: run.at,
      completedAt: run.at,
    })
    .run();
}

function seedRunChat(db: SqliteDb, run: ContinueAllRun): void {
  const ids = continueAllIds(run.key);
  db.insert(schema.chats)
    .values({
      id: ids.chatId,
      name: run.flowName,
      projectId: run.projectId,
      taskId: ids.taskId,
      createdAt: run.at,
      updatedAt: run.at,
    })
    .run();
  db.insert(schema.subChats)
    .values({
      id: ids.subChatId,
      name: run.flowName,
      chatId: ids.chatId,
      mode: 'agent',
      sessionId: run.answered ? `qa-fixture-continue-all-${run.key}-session` : null,
      createdAt: run.at,
      updatedAt: run.at,
    })
    .run();
  if (!run.answered) return;
  // The dispatch stamp followed by a reply is the proof a session answered this step.
  seedTranscript(db, ids.subChatId, [
    {
      id: `qa-fixture-continue-all-${run.key}-user`,
      role: 'user',
      parts: [{ type: 'text', text: run.step.label }],
      metadata: { dispatchTaskId: ids.taskId },
    },
    {
      id: `qa-fixture-continue-all-${run.key}-assistant`,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Drafting the release notes — first the' }],
    },
  ]);
}

export function seedContinueAllFixture(db: SqliteDb): void {
  for (const run of CONTINUE_ALL_RUNS) {
    seedRunRows(db, run);
    seedRunTask(db, run);
    seedRunChat(db, run);
  }
}

/** Every run stays restart-interrupted with no admission, the state the banner lists. */
export function verifyContinueAllFixture(db: SqliteDb): boolean {
  const admissions = db.select().from(schema.flowRunAdmissions).all();
  return CONTINUE_ALL_RUNS.every(({ key }) => {
    const { runId } = continueAllIds(key);
    return isRestartInterrupted(db, runId) && !admissions.some((a) => a.flowRunId === runId);
  });
}
