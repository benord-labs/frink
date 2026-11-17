import { setTimeout as delay } from 'node:timers/promises';
import type {
  CopilotClient,
  CopilotClientOptions,
  CopilotSession,
  MessageOptions,
  ModelInfo,
  ProviderConfig,
  SessionEvent,
  SessionHooks,
} from '@github/copilot-sdk';
import log from 'electron-log';
import { EFFORT_LABEL, modelRowFor } from '../../../../shared/lib/model-picker-label/groups';
import type { ClaudeSdkEffortLevel } from '../../../../shared/types/execution';
import { createThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import { ACTED_UNASKED_TEXT } from '../acp/acp-runner';
import { type AgentModel, rememberAgentModels, rememberedAgentModels } from '../agent-models';
import { ChunkQueue } from '../codex/chunk-queue';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import { completeTurnChunks, makeChunkSink } from '../codex/codex-stream-chunks';
import { createCopilotEventState, mapCopilotEvent } from './copilot-events';
import { createCopilotGate } from './copilot-gate';
import {
  type CheckedSession,
  type CopilotSessionHost,
  copilotSessionOptions,
  MANAGED,
  managedLayerProblem,
  openCheckedSession,
  prepareConfigDirectory,
} from './copilot-session';
import type { CopilotTools } from './copilot-tools';

/** How long a client gets to stop on its own before it is force-stopped. */
const STOP_GRACE_MS = 1500;
/** How often a running turn checks that Copilot still answers. */
const PING_MS = 1000;
/** How long Copilot gets to list its models before the saved list stands in. */
const LIST_MODELS_MS = 3000;
// An organisation-required plugin being installed; this SDK release has no type for it yet.
const MANAGED_PLUGIN_PROGRESS = 'session.managed_plugin_progress';
const SETTINGS_LOST =
  "GitHub Copilot stopped confirming Frink's safety settings, so Frink stopped it. Any steps shown above already ran.";
const COPILOT_STOPPED =
  'GitHub Copilot stopped unexpectedly, so this turn ended. Any steps shown above already ran.';

// The main agent is done, even while a command it left running waits; stopping the client ends it.
const TURN_ENDS = new Set<SessionEvent['type']>([
  'assistant.idle',
  'session.idle',
  'session.error',
]);

/** The parts of a Copilot session one turn uses. */
export type CopilotTurnSession = CheckedSession & {
  rpc: { tasks: Pick<CopilotSession['rpc']['tasks'], 'list'> };
  sessionId: string;
  send(options: MessageOptions): Promise<string>;
  abort(): Promise<void>;
};

/** The parts of a Copilot client one turn uses. */
export type CopilotTurnClient = CopilotSessionHost<CopilotTurnSession> &
  Pick<CopilotClient, 'start' | 'stop' | 'forceStop' | 'ping' | 'listModels'>;

type PreToolUseHandler = NonNullable<SessionHooks['onPreToolUse']>;

export type CopilotRunnerParams = {
  launch: {
    command: string;
    args: string[];
    env: Record<string, string>;
    configDirectory: string;
    tools: CopilotTools;
    versions: { floor: string; below: string };
  };
  cwd: string;
  prompt: string;
  /** Sent instead of `prompt` when the earlier session could not be continued. */
  freshSessionFallbackPrompt?: string;
  resumeSessionId?: string;
  /** The chat's picker id, such as `gpt-6/high`, checked against the models Copilot offers. */
  model?: string;
  mode?: 'plan';
  images?: { data: string; mimeType: string }[];
  abortController: AbortController;
  checkApproval: CodexApprovalCheck;
};

export type CopilotRunnerDeps = {
  createClient?: (options: CopilotClientOptions) => CopilotTurnClient;
  /** Admission tests only: a scripted local model. */
  provider?: ProviderConfig;
  /** Admission tests only: replaces Frink's answer to prove Copilot's own check holds alone. */
  gateWrapper?: (hook: PreToolUseHandler) => PreToolUseHandler;
  /** Tests only: how long Copilot gets to list its models. */
  listModelsMs?: number;
};

type CopilotSdk = typeof import('@github/copilot-sdk');
let copilotSdk: Promise<CopilotSdk> | undefined;
const liveClients = new Map<CopilotTurnClient, CopilotTurn>();

function loadCopilotSdk(): Promise<CopilotSdk> {
  copilotSdk ??= import('@github/copilot-sdk');
  return copilotSdk;
}

/** One row per model, or per effort where it offers a choice, so a saved effort outlives a new default. */
function modelRows(model: ModelInfo): AgentModel[] {
  const { id, name, capabilities, defaultReasoningEffort } = model;
  // A free plan's model comes with no supports block at all.
  const efforts = capabilities?.supports?.reasoningEffort ? model.supportedReasoningEfforts : [];
  const known = (efforts ?? []).filter((effort) => Object.hasOwn(EFFORT_LABEL, effort));
  if (known.length === 0) return [{ id, name }];
  return known.map((effort) => ({
    id: `${id}/${effort}`,
    name,
    familyId: id,
    effort,
    detail: EFFORT_LABEL[effort],
    ...(effort === defaultReasoningEffort && { effortDefault: true }),
  }));
}

/** Copilot's models, saved for the picker whenever they arrive; none when it cannot list them. */
async function listAndSaveModels(client: CopilotTurnClient): Promise<AgentModel[]> {
  try {
    const rows = (await client.listModels()).flatMap(modelRows);
    rememberAgentModels('copilot', rows);
    return rows;
  } catch (error) {
    log.warn('[Copilot] Could not list models', error);
    return [];
  }
}

/** The models Copilot offers now; the saved list when it cannot say in time. */
async function offeredModels(client: CopilotTurnClient, waitMs: number): Promise<AgentModel[]> {
  // A late answer is still saved, so a slow listing refreshes the list for the next turn.
  const listing = listAndSaveModels(client);
  const rows = await Promise.race([listing, delay(waitMs, [], { ref: false })]);
  if (rows.length > 0) return rows;
  log.warn('[Copilot] Got no models in time; checking the saved list');
  return rememberedAgentModels('copilot');
}

type ModelChoice = { model?: string; reasoningEffort?: ClaudeSdkEffortLevel; refusal?: string };

/** The model and effort for a picker id, or the refusal for a model Copilot no longer offers. */
function chooseModel(rows: AgentModel[], picked: string | undefined): ModelChoice {
  if (!picked) return {};
  const { model, effort, offered, row } = modelRowFor(rows, picked);
  // With no list at all, the model goes to Copilot unchecked.
  if (rows.length === 0) return { model, reasoningEffort: effort };
  if (!offered) return { refusal: `GitHub Copilot no longer offers ${model}. Pick another model.` };
  return { model, reasoningEffort: row?.effort };
}

/** Signals a command's whole process group; false once nothing is left in it. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-pid, signal);
  } catch {
    return false;
  }
}

/** Stops the client, then ends what the turn's commands left running, even if it ignores that. */
async function closeClient(client: CopilotTurnClient, turn: CopilotTurn): Promise<void> {
  await Promise.race([turn.noteCommands(), delay(STOP_GRACE_MS, undefined, { ref: false })]);
  try {
    const stopped = client.stop().then(
      () => true,
      () => false,
    );
    if (!(await Promise.race([stopped, delay(STOP_GRACE_MS, false, { ref: false })]))) {
      await client.forceStop();
    }
  } finally {
    turn.endGroups();
    liveClients.delete(client);
  }
}

/** Stops every client still running, for when Frink quits. */
export async function disposeAllCopilotClients(): Promise<void> {
  await Promise.allSettled([...liveClients].map(([client, turn]) => closeClient(client, turn)));
}

function messageFor(params: CopilotRunnerParams, lostHistory: boolean): MessageOptions {
  const prompt = lostHistory ? (params.freshSessionFallbackPrompt ?? params.prompt) : params.prompt;
  const attachments = (params.images ?? []).map(
    ({ data, mimeType }): NonNullable<MessageOptions['attachments']>[number] => ({
      type: 'blob',
      data,
      mimeType,
    }),
  );
  return { prompt, attachments };
}

/** One turn's stream, gate and client, and the ways the turn can end. */
class CopilotTurn {
  readonly queue = new ChunkQueue();
  readonly openTextIds = new Set<string>();
  readonly thinking = createThinkingEmitter();
  private readonly emit = makeChunkSink(this.queue, this.openTextIds, this.thinking);
  private readonly shown = createCopilotEventState();
  // Aborted once the turn takes no more answers, so a late hook call is refused.
  private readonly over = new AbortController();
  readonly gate: ReturnType<typeof createCopilotGate>;
  client?: CopilotTurnClient;
  session?: CopilotTurnSession;
  // Noted while each command runs: Copilot drops a quick one, or dies, before the turn ends.
  private readonly commandGroups = new Set<number>();
  // Emptied groups, never noted again: Copilot still lists them, but their ids may be reused.
  private readonly endedGroups = new Set<number>();
  // Set once Copilot is stopped, so a command listed after that is ended at once.
  private released = false;

  constructor(params: CopilotRunnerParams) {
    this.gate = createCopilotGate({
      cwd: params.cwd,
      tools: params.launch.tools,
      checkApproval: params.checkApproval,
      turnOver: this.over.signal,
      plan: {
        configDirectory: params.launch.configDirectory,
        sessionId: () => this.session?.sessionId,
      },
    });
  }

  get isOver(): boolean {
    return this.over.signal.aborted;
  }

  end(): void {
    this.over.abort();
    this.queue.finish();
  }

  /** Ends the turn with an error and stops Copilot as a user stop would. */
  halt(errorText: string): void {
    if (this.isOver) return;
    log.warn(`[Copilot] Stopping the turn: ${errorText}`);
    this.emit({ type: 'error', errorText });
    this.stop();
  }

  // This SDK reports a lost connection to no public hook, so a failed ping is the sign.
  watch(client: CopilotTurnClient): void {
    const timer = setInterval(() => {
      client.ping().catch(() => this.halt(COPILOT_STOPPED));
      this.liveGroups();
    }, PING_MS);
    this.over.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  }

  /** Notes the process group of every command Copilot lists now. */
  async noteCommands(): Promise<void> {
    const listed = await this.session?.rpc.tasks.list().catch(() => undefined);
    for (const task of listed?.tasks ?? []) {
      // A finished command's id may already name another program, so only running ones count.
      if (task.type !== 'shell' || task.status !== 'running' || !task.pid) continue;
      if (!this.endedGroups.has(task.pid)) this.commandGroups.add(task.pid);
    }
    if (this.released) this.endGroups();
  }

  /** Ends every noted group that still has a process, now and for any listed later. */
  endGroups(): void {
    this.released = true;
    for (const pid of this.liveGroups()) signalGroup(pid, 'SIGKILL');
  }

  /** The noted groups with a process left; checked every tick to drop emptied ones at once. */
  liveGroups(): number[] {
    for (const pid of this.commandGroups) {
      if (signalGroup(pid, 0)) continue;
      this.commandGroups.delete(pid);
      this.endedGroups.add(pid);
    }
    return [...this.commandGroups];
  }

  // The client is then stopped gracefully: a force-stop leaves its background commands running.
  readonly stop = (): void => {
    this.end();
    const stopping = this.session ? this.session.abort() : this.client?.forceStop();
    void stopping?.catch((error) => log.warn('[Copilot] Stop failed', error));
  };

  readonly onEvent = (event: SessionEvent): void => {
    const type: string = event.type;
    if (type === MANAGED_PLUGIN_PROGRESS) this.halt(MANAGED);
    // Reports while the session opens are checked by the open itself.
    if (!this.session || this.isOver) return;
    if (event.type === 'session.managed_settings_resolved') {
      const problem = managedLayerProblem(event.data);
      if (problem) this.halt(problem === MANAGED ? MANAGED : SETTINGS_LOST);
      return;
    }
    if (event.type === 'session.background_tasks_changed') void this.noteCommands();
    if (event.type === 'tool.execution_start') {
      const { toolCallId, toolName, arguments: args } = event.data;
      this.gate.noteExecutionStart(toolCallId, toolName, args);
    }
    mapCopilotEvent(event, this.shown).forEach(this.emit);
    if (
      event.type === 'tool.execution_complete' &&
      this.gate.actedUnasked(event.data.toolCallId, event.data)
    ) {
      this.halt(ACTED_UNASKED_TEXT);
    }
    if (!event.agentId && TURN_ENDS.has(event.type)) this.end();
  };
}

/** Starts Copilot, opens the checked session and sends the prompt; the turn streams through events. */
async function startTurn(turn: CopilotTurn, params: CopilotRunnerParams, deps: CopilotRunnerDeps) {
  const { launch } = params;
  const sdk = await loadCopilotSdk();
  await prepareConfigDirectory(launch.configDirectory);
  params.abortController.signal.throwIfAborted();
  if (turn.isOver) return;
  const createClient = deps.createClient ?? ((options) => new sdk.CopilotClient(options));
  const client = createClient({
    connection: sdk.RuntimeConnection.forStdio({
      path: launch.command,
      args: launch.args,
      env: launch.env,
    }),
    workingDirectory: params.cwd,
  });
  turn.client = client;
  liveClients.set(client, turn);
  await client.start();
  // Opening a session would start a stopped client again.
  if (turn.isOver) return;
  turn.watch(client);
  // Copilot opens a session on any model name, so the choice is checked against its list instead.
  const offered = await offeredModels(client, deps.listModelsMs ?? LIST_MODELS_MS);
  const choice = chooseModel(offered, params.model);
  if (turn.isOver) return;
  if (choice.refusal) return turn.halt(choice.refusal);
  const options = copilotSessionOptions({
    cwd: params.cwd,
    configDirectory: launch.configDirectory,
    tools: launch.tools,
    gate: turn.gate,
    onEvent: turn.onEvent,
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
  });
  const opened = await openCheckedSession(client, {
    options: {
      ...options,
      provider: deps.provider,
      hooks: { onPreToolUse: deps.gateWrapper?.(turn.gate.onPreToolUse) ?? turn.gate.onPreToolUse },
    },
    resumeSessionId: params.resumeSessionId,
    plan: params.mode === 'plan',
    versions: launch.versions,
  });
  if (!opened.ok) return turn.halt(opened.reason);
  if (turn.isOver) return;
  turn.session = opened.session;
  turn.queue.push({
    type: 'message-metadata',
    messageMetadata: { sessionId: opened.session.sessionId },
  });
  const lostHistory = Boolean(params.resumeSessionId) && !opened.resumed;
  await opened.session.send(messageFor(params, lostHistory));
}

/** Runs one turn of GitHub Copilot through Frink's gate and streams UI chunks. */
export async function* runCopilotAgent(
  params: CopilotRunnerParams,
  deps: CopilotRunnerDeps = {},
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const { signal } = params.abortController;
  yield { type: 'start' };
  const turn = new CopilotTurn(params);
  signal.addEventListener('abort', turn.stop, { once: true });
  try {
    // Not awaited, so a stop while Copilot is unresponsive still ends the turn and the client.
    void startTurn(turn, params, deps).catch((error) => {
      if (!signal.aborted) turn.halt(error instanceof Error ? error.message : String(error));
      turn.end();
    });
    yield* turn.queue.drain();
  } finally {
    signal.removeEventListener('abort', turn.stop);
    turn.end();
    // Before the first yield: a reader that stops listening never resumes this generator.
    if (turn.client) {
      void closeClient(turn.client, turn).catch((error) =>
        log.warn('[Copilot] Did not stop', error),
      );
    }
    yield* completeTurnChunks(turn.thinking, turn.openTextIds);
    const sessionId = turn.session?.sessionId;
    yield { type: 'finish', messageMetadata: sessionId ? { sessionId } : undefined };
  }
}
