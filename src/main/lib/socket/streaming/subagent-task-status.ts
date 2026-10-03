/**
 * Display-only trackers fed by the SDK's task frames: background subagent liveness, Workflow
 * progress, and the live background-task roster behind the background-work row.
 *
 * An async Agent launch resolves its tool part immediately, so the renderer card reads "Completed
 * Subagent" while the task runs; `task_started`/`task_notification` carry the `tool_use_id` that
 * correlates a task to its card (optional in the SDK contract, populated by the CLI for Task-tool
 * agents). This lane never feeds the stand-down decision — the Stop hook's background_tasks
 * snapshot remains the authority (docs/decisions/unattended-wake-budget.md).
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  BackgroundRosterPayload,
  BackgroundRosterTask,
  SubagentTaskChangedPayload,
} from '../../../../shared/types/wake-hold/subagent-task';
import type {
  WorkflowAgentProgress,
  WorkflowProgressView,
} from '../../../../shared/types/wake-hold/workflow-progress';
import { captureMainException } from '../../sentry/init';

/** Per chat: task_id → tool_use_id. Keyed on the REQUIRED field so a terminal frame that omits
 * the optional tool_use_id can still retire its entry instead of stranding a spinning card. */
const runningByChat = new Map<string, Map<string, string>>();

/** Per chat: workflow task_id → its latest progress snapshot, pulled while the user watches it. */
const workflowProgressByChat = new Map<string, Map<string, WorkflowProgressView>>();

let publish: ((payload: SubagentTaskChangedPayload) => void) | null = null;

/** Per chat: the latest `background_tasks_changed` set. A REPLACE-semantics level signal, so a missed
 * start/notification bookend can never strand a stale row. */
const rosterByChat = new Map<string, BackgroundRosterTask[]>();

/** Per chat: tasks the last Stop hook judged finished followers (task-stop-hook.ts) — never shown. */
const ignoredByChat = new Map<string, ReadonlySet<string>>();

let publishRoster: ((payload: BackgroundRosterPayload) => void) | null = null;

/** Injected at boot (src/main/lib/socket/index.ts) so this module stays IO-free and test-spyable. */
export function setSubagentTaskPublisher(
  fn: ((payload: SubagentTaskChangedPayload) => void) | null,
): void {
  publish = fn;
}

export function setBackgroundRosterPublisher(
  fn: ((payload: BackgroundRosterPayload) => void) | null,
): void {
  publishRoster = fn;
}

type TaskFrame = {
  type?: string;
  subtype?: string;
  task_id?: string;
  tool_use_id?: string;
  subagent_type?: string;
  task_type?: string;
  skip_transcript?: boolean;
  /** Undocumented CLI field: a full snapshot of a Workflow's phases and agents, absent between. */
  workflow_progress?: unknown;
  /** `background_tasks_changed` only: every live task after the change. */
  tasks?: unknown;
};

/** Only agent-shaped and workflow tasks address a tool card (Task/Agent, Workflow); shells, crons
 * and housekeeping tasks have no card to drive and would be pure broadcast noise. */
function isCardTaskStart(frame: TaskFrame): boolean {
  if (frame.skip_transcript) return false;
  const taskType = String(frame.task_type ?? '');
  return (
    Boolean(frame.subagent_type) || taskType.endsWith('agent') || taskType === 'local_workflow'
  );
}

/**
 * Observe one SDK frame. TOTAL by design — this runs inside the registry's frame chokepoint,
 * where a throw is indistinguishable from the SDK stream dying: the wake pump would finish as
 * 'stream-ended' and dispose a live held session over a cosmetic status signal.
 */
export function noteSubagentTaskFrame(subChatId: string, message: SDKMessage): void {
  if ((message as TaskFrame).type !== 'system') return;
  try {
    const frame = message as TaskFrame;
    if (frame.subtype === 'task_progress') return noteWorkflowProgress(subChatId, frame);
    if (frame.subtype === 'background_tasks_changed') return noteRoster(subChatId, frame.tasks);
    if (frame.subtype === 'task_started') return noteSubagentStart(subChatId, frame);
    if (frame.subtype === 'task_notification') return noteTaskEnd(subChatId, frame);
  } catch (error) {
    captureMainException(error, { surface: 'subagent-task-status', stage: 'note-frame' });
  }
}

function noteSubagentStart(subChatId: string, frame: TaskFrame): void {
  if (!frame.task_id || !frame.tool_use_id || !isCardTaskStart(frame)) return;
  const chat = runningByChat.get(subChatId) ?? new Map<string, string>();
  if (chat.has(frame.task_id)) return;
  chat.set(frame.task_id, frame.tool_use_id);
  runningByChat.set(subChatId, chat);
  publish?.({ subChatId, toolCallId: frame.tool_use_id, running: true });
}

function noteTaskEnd(subChatId: string, frame: TaskFrame): void {
  if (!frame.task_id) return;
  workflowProgressByChat.get(subChatId)?.delete(frame.task_id);
  const chat = runningByChat.get(subChatId);
  const toolCallId = chat?.get(frame.task_id);
  if (!chat || toolCallId === undefined) return;
  chat.delete(frame.task_id);
  if (chat.size === 0) runningByChat.delete(subChatId);
  publish?.({ subChatId, toolCallId, running: false });
}

/** Retract every tracked id for a chat — called from BOTH session-detach seams (endSession and
 * unregisterSessionIfOwned). A silent map drop never crosses IPC, which would strand spinners. */
export function clearSubagentTasks(subChatId: string): void {
  workflowProgressByChat.delete(subChatId);
  ignoredByChat.delete(subChatId);
  // The roster is per CLI process, so a detached session's set must not outlive it (SDK contract).
  if (rosterByChat.delete(subChatId)) {
    try {
      publishRoster?.({ subChatId, tasks: null });
    } catch (error) {
      captureMainException(error, { surface: 'subagent-task-status', stage: 'roster-retract' });
    }
  }
  const chat = runningByChat.get(subChatId);
  if (!chat) return;
  runningByChat.delete(subChatId);
  for (const toolCallId of chat.values()) {
    // Caught per id: one failed publish must not strand the REMAINING cards as running.
    try {
      publish?.({ subChatId, toolCallId, running: false });
    } catch (error) {
      captureMainException(error, { surface: 'subagent-task-status', stage: 'retract' });
    }
  }
}

/** Boot pull for a renderer that reloaded mid-task (a start is only ever pushed once). Wire-shaped
 * and task_id-free: the card is addressed by its tool call alone. */
export function listRunningSubagentTasks(): SubagentTaskChangedPayload[] {
  const running: SubagentTaskChangedPayload[] = [];
  for (const [subChatId, chat] of runningByChat) {
    for (const toolCallId of chat.values()) running.push({ subChatId, toolCallId, running: true });
  }
  return running;
}

/** A malformed entry is dropped rather than trusted. The id is kept whole, never cut: it is what the
 * row and the Stop hook share, and a cut one would match nothing. */
function parseRosterTask(entry: unknown): BackgroundRosterTask | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const fields = entry as Record<string, unknown>;
  const id = fields.task_id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    id,
    type: text(fields.task_type) ?? '',
    description: text(fields.description) ?? '',
    ambient: fields.ambient === true,
  };
}

function noteRoster(subChatId: string, tasks: unknown): void {
  if (!Array.isArray(tasks)) return;
  const roster = tasks.flatMap((entry) => parseRosterTask(entry) ?? []);
  rosterByChat.set(subChatId, roster);
  // A dead-follower verdict lasts until its task leaves the CLI's set, not until the next Stop.
  const ignored = ignoredByChat.get(subChatId);
  if (ignored) {
    const live = new Set(roster.map((task) => task.id));
    const kept = new Set([...ignored].filter((id) => live.has(id)));
    if (kept.size > 0) ignoredByChat.set(subChatId, kept);
    else ignoredByChat.delete(subChatId);
  }
  publishRosterFor(subChatId);
}

function visibleRoster(subChatId: string, roster: BackgroundRosterTask[]): BackgroundRosterTask[] {
  const ignored = ignoredByChat.get(subChatId);
  return roster.filter((task) => !ignored?.has(task.id));
}

function publishRosterFor(subChatId: string): void {
  const roster = rosterByChat.get(subChatId);
  if (roster) publishRoster?.({ subChatId, tasks: visibleRoster(subChatId, roster) });
}

/** Boot pull for a renderer that reloaded: the roster is pushed only on a membership change. */
export function listBackgroundRosters(): BackgroundRosterPayload[] {
  return [...rosterByChat].map(([subChatId, roster]) => ({
    subChatId,
    tasks: visibleRoster(subChatId, roster),
  }));
}

/** Adds the Stop hook's dead followers for this chat, re-publishing the roster on a change since the
 * roster itself only re-sends on a membership change. Never throws (called from a hook). */
export function ignoreBackgroundTasks(subChatId: string, ids: ReadonlySet<string>): void {
  try {
    const previous = ignoredByChat.get(subChatId) ?? new Set<string>();
    if ([...ids].every((id) => previous.has(id))) return;
    ignoredByChat.set(subChatId, new Set([...previous, ...ids]));
    publishRosterFor(subChatId);
  } catch (error) {
    captureMainException(error, { surface: 'subagent-task-status', stage: 'roster-ignore' });
  }
}

/** The latest snapshot of one of the chat's running Workflows, or null when none has arrived. */
export function readWorkflowProgress(
  subChatId: string,
  taskId: string,
): WorkflowProgressView | null {
  return workflowProgressByChat.get(subChatId)?.get(taskId) ?? null;
}

/** An absent `workflow_progress` means "unchanged", so the last snapshot stays. Any present value
 * replaces it; one with nothing usable (or not a list at all) clears it, so the row falls back. */
function noteWorkflowProgress(subChatId: string, frame: TaskFrame): void {
  if (!frame.task_id || frame.workflow_progress === undefined) return;
  const chat = workflowProgressByChat.get(subChatId);
  chat?.delete(frame.task_id); // first, so a snapshot that fails to parse cannot leave a stale one
  const entries = frame.workflow_progress;
  const view = Array.isArray(entries) ? parseWorkflowProgress(entries) : null;
  if (!view) return;
  const next = chat ?? new Map<string, WorkflowProgressView>();
  next.set(frame.task_id, view);
  workflowProgressByChat.set(subChatId, next);
}

const MAX_TEXT = 200;
const MAX_ENTRIES = 1000;
const MAX_PHASES = 50;
const MAX_AGENTS = 200;

/** Bounded at MAX_TEXT, never splitting a surrogate pair: a lone half renders as a broken glyph. */
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const cut = value.slice(0, MAX_TEXT);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const byIndex = (a: { index: number }, b: { index: number }): number => a.index - b.index;

/** The field is untyped CLI output, so anything unrecognised is dropped rather than trusted. Entries
 * repeat per `type:index` and the last one wins. Null when nothing usable remains. */
export function parseWorkflowProgress(entries: unknown[]): WorkflowProgressView | null {
  const phases: Phases = new Map();
  const agents: Agents = new Map();
  for (const entry of entries.slice(0, MAX_ENTRIES)) noteProgressEntry(entry, phases, agents);
  if (phases.size === 0 && agents.size === 0) return null;
  return { phases: [...phases.values()].sort(byIndex), agents: [...agents.values()].sort(byIndex) };
}

type Phases = Map<number, { index: number; title: string }>;
type Agents = Map<number, WorkflowAgentProgress>;

/** Files one snapshot entry under its phase or agent slot; anything else is dropped. */
function noteProgressEntry(entry: unknown, phases: Phases, agents: Agents): void {
  if (typeof entry !== 'object' || entry === null) return;
  const fields = entry as Record<string, unknown>;
  const index = finite(fields.index);
  if (index === undefined) return;
  if (fields.type === 'workflow_phase') notePhase(index, fields, phases);
  if (fields.type === 'workflow_agent') noteAgent(index, fields, agents);
}

function notePhase(index: number, fields: Record<string, unknown>, phases: Phases): void {
  if (!phases.has(index) && phases.size >= MAX_PHASES) return;
  const title = text(fields.title);
  if (title) phases.set(index, { index, title });
  else phases.delete(index); // the last entry wins, even an unusable one
}

function noteAgent(index: number, fields: Record<string, unknown>, agents: Agents): void {
  if (!agents.has(index) && agents.size >= MAX_AGENTS) return;
  const agent = parseWorkflowAgent(index, fields);
  if (agent) agents.set(index, agent);
  else agents.delete(index); // the last entry wins, even an unusable one
}

function parseWorkflowAgent(
  index: number,
  fields: Record<string, unknown>,
): WorkflowAgentProgress | null {
  const label = text(fields.label);
  const startedAt = finite(fields.startedAt);
  const state = agentState(fields.state, startedAt);
  if (!label || !state) return null;
  const tool = text(fields.lastToolName);
  const summary = text(fields.lastToolSummary);
  return {
    index,
    label,
    state,
    phaseIndex: finite(fields.phaseIndex),
    startedAt,
    durationMs: finite(fields.durationMs),
    activity: tool && summary ? `${tool} · ${summary}` : tool,
    error: text(fields.error),
  };
}

/** The CLI reports a queued agent and a running one both as 'start'; only the latter has started. */
function agentState(
  state: unknown,
  startedAt: number | undefined,
): WorkflowAgentProgress['state'] | null {
  if (state === 'start') return startedAt === undefined ? 'queued' : 'running';
  if (state === 'progress') return 'running';
  if (state === 'done' || state === 'error') return state;
  return null;
}

export function __resetSubagentTaskStatusForTest(): void {
  workflowProgressByChat.clear();
  runningByChat.clear();
  rosterByChat.clear();
  ignoredByChat.clear();
  publish = null;
  publishRoster = null;
}
