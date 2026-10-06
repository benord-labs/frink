/** The seed’s self-check: row counts and the shape every scenario relies on. */
import { existsSync } from 'node:fs';
import * as schema from '../../../src/main/lib/db/schema';
import { RESTART_INTERRUPTION_REASON } from '../../../src/shared/types/flow';
import { verifyCodexFixture } from './codex';
import { FIXTURE_ACCOUNT_ID, FIXTURE_CHAT_SEEDED_ID, FIXTURE_HISTORY_CANCELLED_ID, FIXTURE_HISTORY_COMPLETED_ID, FIXTURE_PROJECT_ID, FIXTURE_TASK_ID, type SqliteDb } from './base';
import { FIXTURE_INTERRUPTED, FIXTURE_PAUSED_CHAT_ID, FIXTURE_PAUSED_MODEL_ID, FIXTURE_PAUSED_RUN_ID, FIXTURE_PAUSED_SUB_CHAT_ID, FIXTURE_PAUSED_TASK_ID, FIXTURE_QUEUED_RESUME_RUN_ID, FIXTURE_QUEUED_START_RUN_ID, FIXTURE_RUNNING_CHAT_ID, FIXTURE_RUNNING_MODEL_ID, FIXTURE_RUNNING_RUN_ID, FIXTURE_RUNNING_SUB_CHAT_ID, FIXTURE_RUNNING_TASK_ID } from './flows';
import { FIXTURE_FLOW_CHAT_ID, FIXTURE_FLOW_TASK_DONE_ID, FIXTURE_FLOW_TASK_PARKED_ID } from './messages';

const FILE_SCHEME = 'file://';

/**
 * The seeded account MUST be the authenticated default passthrough shape, or the chat surface stays
 * stuck on the account empty state — a silent half-seed there wastes a whole drive. Extracted from
 * verifyFixtures so that function stays under the complexity budget.
 */
function isSeededAccountShapeOk(
  account:
    | {
        source?: string | null;
        sourcePath?: string | null;
        isDefault?: boolean | null;
        needsReauthAt?: Date | null;
      }
    | undefined,
): boolean {
  if (!account) return false;
  // A passthrough row whose source the probe cannot find is flagged on its first resolution, so
  // the file has to be there, not just named.
  const sourceFile = account.sourcePath?.startsWith(FILE_SCHEME)
    ? account.sourcePath.slice(FILE_SCHEME.length)
    : null;
  return (
    account.source === 'claude-passthrough' &&
    sourceFile !== null &&
    existsSync(sourceFile) &&
    account.isDefault === true &&
    !account.needsReauthAt
  );
}

/** Row counts the seed must produce; used by the runner's self-check and tests. */
type FixtureRows = {
  chats: { id: string; taskId?: string | null }[];
  subChats: { id: string; chatId: string; sessionId?: string | null }[];
  tasks: {
    id: string;
    status: string;
    flowRunId?: string | null;
    result?: unknown;
    triggerContext?: unknown;
  }[];
  flowRuns: { id: string; status: string; triggerContext?: unknown }[];
  flowRunAdmissions: { flowRunId: string; state: string; priorityClass: string }[];
  nodeRuns: { id: string; status: string; nodeOutput?: unknown }[];
};

/**
 * Row lookups return a concrete shape or `undefined`; each verifier guards ONCE up front so the
 * checks below dereference plainly. Optional-chaining every clause instead is what pushed these over
 * the complexity gate — fallow estimates coverage from export references, so a module-private
 * predicate is scored as fully uncovered and its CRAP is dominated by raw branch count.
 */
type Cfg = { model?: string; startMode?: string };
const cfgOf = (t: { triggerContext?: unknown }): Cfg =>
  ((t.triggerContext as { _config?: Cfg } | null)?._config ?? {}) as Cfg;
const subChatIdOf = (t: { result?: unknown }): string | undefined =>
  (t.result as { subChatId?: string } | null)?.subChatId;
const runChatLink = (run: { triggerContext?: unknown }): { subChatId?: string; chatId?: string } =>
  (run.triggerContext as { subChatId?: string; chatId?: string } | null) ?? {};

function verifyParkedFlow(r: FixtureRows): boolean {
  const done = r.tasks.find((t) => t.id === FIXTURE_FLOW_TASK_DONE_ID);
  const parked = r.tasks.find((t) => t.id === FIXTURE_FLOW_TASK_PARKED_ID);
  const chat = r.chats.find((c) => c.id === FIXTURE_FLOW_CHAT_ID);
  if (!done || !parked || !chat) return false;
  return [
    done.status === 'done',
    parked.status === 'needs_attention',
    chat.taskId === FIXTURE_FLOW_TASK_DONE_ID,
  ].every(Boolean);
}

/** Validate the WHOLE chain — a broken sub-chat, run link or model/mode renders the wrong surface. */
function verifyPausedFlow(r: FixtureRows): boolean {
  const task = r.tasks.find((t) => t.id === FIXTURE_PAUSED_TASK_ID);
  const run = r.flowRuns.find((x) => x.id === FIXTURE_PAUSED_RUN_ID);
  if (!task || !run) return false;
  const cfg = cfgOf(task);
  return [
    task.status === 'needs_attention',
    task.flowRunId === FIXTURE_PAUSED_RUN_ID,
    cfg.model === FIXTURE_PAUSED_MODEL_ID,
    cfg.startMode === 'plan',
    run.status === 'paused',
    runChatLink(run).subChatId === FIXTURE_PAUSED_SUB_CHAT_ID,
    r.subChats.some((x) => x.id === FIXTURE_PAUSED_SUB_CHAT_ID),
    r.chats.some((c) => c.id === FIXTURE_PAUSED_CHAT_ID),
  ].every(Boolean);
}

/**
 * `done` (not `running`) is load-bearing: a running task/run is swept terminal at boot, so this also
 * catches a regression that "corrects" the status back to running and makes the strip vanish.
 */
function verifyRunningFlow(r: FixtureRows): boolean {
  const task = r.tasks.find((t) => t.id === FIXTURE_RUNNING_TASK_ID);
  const run = r.flowRuns.find((x) => x.id === FIXTURE_RUNNING_RUN_ID);
  const chat = r.chats.find((c) => c.id === FIXTURE_RUNNING_CHAT_ID);
  const subChat = r.subChats.find((x) => x.id === FIXTURE_RUNNING_SUB_CHAT_ID);
  if (!task || !run || !chat || !subChat) return false;
  const cfg = cfgOf(task);
  return [
    task.status === 'done',
    task.flowRunId === FIXTURE_RUNNING_RUN_ID,
    subChatIdOf(task) === FIXTURE_RUNNING_SUB_CHAT_ID,
    cfg.model === FIXTURE_RUNNING_MODEL_ID,
    cfg.startMode === 'agent',
    run.status === 'paused',
    runChatLink(run).subChatId === FIXTURE_RUNNING_SUB_CHAT_ID,
    chat.taskId === FIXTURE_RUNNING_TASK_ID,
    subChat.chatId === FIXTURE_RUNNING_CHAT_ID,
  ].every(Boolean);
}

/**
 * The marker and the session are asserted explicitly: without the marker the row does not render at
 * all, and without the session it silently downgrades from "Resume" to "Re-run step".
 */
function verifyInterruptedFlow(r: FixtureRows): boolean {
  const task = r.tasks.find((t) => t.id === FIXTURE_INTERRUPTED.taskId);
  const run = r.flowRuns.find((x) => x.id === FIXTURE_INTERRUPTED.runId);
  const nodeRun = r.nodeRuns.find((n) => n.id === FIXTURE_INTERRUPTED.nodeRunId);
  const subChat = r.subChats.find((x) => x.id === FIXTURE_INTERRUPTED.subChatId);
  const chat = r.chats.find((c) => c.id === FIXTURE_INTERRUPTED.chatId);
  if (!task || !run || !nodeRun || !subChat || !chat) return false;
  const nodeError = (nodeRun.nodeOutput as { error?: { message?: string } } | null)?.error;
  return [
    task.status === 'cancelled',
    task.flowRunId === FIXTURE_INTERRUPTED.runId,
    subChatIdOf(task) === FIXTURE_INTERRUPTED.subChatId,
    run.status === 'cancelled',
    runChatLink(run).chatId === FIXTURE_INTERRUPTED.chatId,
    nodeRun.status === 'cancelled',
    nodeError?.message === RESTART_INTERRUPTION_REASON,
    subChat.sessionId === FIXTURE_INTERRUPTED.sessionId,
    subChat.chatId === FIXTURE_INTERRUPTED.chatId,
    chat.taskId === FIXTURE_INTERRUPTED.taskId,
  ].every(Boolean);
}

function verifyPlanReadyTask(r: FixtureRows): boolean {
  const task = r.tasks.find((t) => t.id === FIXTURE_TASK_ID);
  const chat = r.chats.find((c) => c.id === FIXTURE_CHAT_SEEDED_ID);
  if (!task || !chat) return false;
  return [task.status === 'plan_ready', chat.taskId === FIXTURE_TASK_ID].every(Boolean);
}

/** Terminal examples keep visual History QA deterministic and independently filterable. */
function verifyHistoryTasks(r: FixtureRows): boolean {
  const completed = r.tasks.find((t) => t.id === FIXTURE_HISTORY_COMPLETED_ID);
  const cancelled = r.tasks.find((t) => t.id === FIXTURE_HISTORY_CANCELLED_ID);
  return completed?.status === 'completed' && cancelled?.status === 'cancelled';
}

/** Both classes must still be queued, or the panel renders one group and the other is undriveable. */
function verifyQueuedAdmissions(r: FixtureRows): boolean {
  const queued = r.flowRunAdmissions.filter((a) => a.state === 'queued');
  return (
    queued.length === 3 &&
    queued.some(
      (a) => a.flowRunId === FIXTURE_QUEUED_START_RUN_ID && a.priorityClass === 'start',
    ) &&
    queued.some((a) => a.flowRunId === FIXTURE_QUEUED_RESUME_RUN_ID && a.priorityClass === 'resume')
  );
}

export function verifyFixtures(db: SqliteDb): { ok: boolean; detail: string } {
  const projects = db.select().from(schema.projects).all();
  const accounts = db.select().from(schema.claudeCodeCredentials).all();
  const r: FixtureRows = {
    chats: db.select().from(schema.chats).all(),
    subChats: db.select().from(schema.subChats).all(),
    tasks: db.select().from(schema.tasks).all(),
    flowRuns: db.select().from(schema.flowRuns).all(),
    flowRunAdmissions: db.select().from(schema.flowRunAdmissions).all(),
    nodeRuns: db.select().from(schema.nodeRuns).all(),
  };
  // Every fixture seeds on every run: 13 chats (incl. two batch members and three background-work
  // chats) / 10 sub-chats / 8 tasks
  // (2 parked + 1 paused + 1 running + 1 interrupted, the plan-ready task, two History examples).
  const expectedCounts = { projects: 2, chats: 13, subChats: 10, tasks: 8 };
  const ok =
    projects.length === expectedCounts.projects &&
    projects[0]?.id === FIXTURE_PROJECT_ID &&
    r.chats.length === expectedCounts.chats &&
    r.subChats.length === expectedCounts.subChats &&
    r.tasks.length === expectedCounts.tasks &&
    verifyPlanReadyTask(r) &&
    verifyHistoryTasks(r) &&
    verifyParkedFlow(r) &&
    verifyPausedFlow(r) &&
    verifyRunningFlow(r) &&
    verifyInterruptedFlow(r) &&
    verifyQueuedAdmissions(r) &&
    verifyCodexFixture(db) &&
    isSeededAccountShapeOk(accounts.find((a) => a.id === FIXTURE_ACCOUNT_ID));
  return {
    ok,
    detail: `projects=${projects.length} chats=${r.chats.length} subChats=${r.subChats.length} tasks=${r.tasks.length} accounts=${accounts.length} queued=${r.flowRunAdmissions.filter((a) => a.state === 'queued').length}`,
  };
}
