import { setTimeout as delay } from 'node:timers/promises';
import type {
  CopilotClient,
  CopilotClientOptions,
  MessageOptions,
  ModelInfo,
  ProviderConfig,
  SessionConfig,
  SessionEvent,
  SessionHooks,
} from '@github/copilot-sdk';
import log from 'electron-log';
import {
  EFFORT_LABEL,
  type PickerGroupFields,
} from '../../../../shared/lib/model-picker-label/groups';
import { createThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import { ACTED_UNASKED_TEXT } from '../acp/acp-runner';
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
// An organisation-required plugin being installed; this SDK release has no type for it yet.
const MANAGED_PLUGIN_PROGRESS = 'session.managed_plugin_progress';
const SETTINGS_LOST =
  "GitHub Copilot stopped confirming Frink's safety settings, so Frink stopped it. Any steps shown above already ran.";

// The main agent is done, even while a command it left running waits; stopping the client ends it.
const TURN_ENDS = new Set<SessionEvent['type']>([
  'assistant.idle',
  'session.idle',
  'session.error',
]);

/** The parts of a Copilot session one turn uses. */
export type CopilotTurnSession = CheckedSession & {
  sessionId: string;
  send(options: MessageOptions): Promise<string>;
  abort(): Promise<void>;
};

/** The parts of a Copilot client one turn uses. */
export type CopilotTurnClient = CopilotSessionHost<CopilotTurnSession> &
  Pick<CopilotClient, 'start' | 'stop' | 'forceStop' | 'listModels'>;

type PreToolUseHandler = NonNullable<SessionHooks['onPreToolUse']>;
/** A picker row: a model, or one effort of a model that offers a choice. */
type CopilotModel = PickerGroupFields & { detail?: string };

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
  model?: string;
  reasoningEffort?: SessionConfig['reasoningEffort'];
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
};

type CopilotSdk = typeof import('@github/copilot-sdk');
let copilotSdk: Promise<CopilotSdk> | undefined;
const liveClients = new Set<CopilotTurnClient>();
let rememberedModels: CopilotModel[] | undefined;

function loadCopilotSdk(): Promise<CopilotSdk> {
  copilotSdk ??= import('@github/copilot-sdk');
  return copilotSdk;
}

/** The models Copilot offered when a turn last opened, or nothing before the first turn. */
export function rememberedCopilotModels(): CopilotModel[] | undefined {
  return rememberedModels;
}

/** One row per model, or per effort where it offers a choice, so a saved effort outlives a new default. */
function modelRows(model: ModelInfo): CopilotModel[] {
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

async function rememberModels(client: CopilotTurnClient): Promise<void> {
  rememberedModels = (await client.listModels()).flatMap(modelRows);
}

/** Stops the client, force-stopping it when it does not stop within a moment. */
async function closeClient(client: CopilotTurnClient): Promise<void> {
  try {
    const stopped = client.stop().then(
      () => true,
      () => false,
    );
    if (!(await Promise.race([stopped, delay(STOP_GRACE_MS, false, { ref: false })]))) {
      await client.forceStop();
    }
  } finally {
    liveClients.delete(client);
  }
}

/** Stops every client still running, for when Frink quits. */
export async function disposeAllCopilotClients(): Promise<void> {
  await Promise.allSettled([...liveClients].map(closeClient));
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
  liveClients.add(client);
  await client.start();
  const options = copilotSessionOptions({
    cwd: params.cwd,
    configDirectory: launch.configDirectory,
    tools: launch.tools,
    gate: turn.gate,
    onEvent: turn.onEvent,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
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
  void rememberModels(client).catch((error) => log.warn('[Copilot] Could not list models', error));
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
      void closeClient(turn.client).catch((error) => log.warn('[Copilot] Did not stop', error));
    }
    yield* completeTurnChunks(turn.thinking, turn.openTextIds);
    const sessionId = turn.session?.sessionId;
    yield { type: 'finish', messageMetadata: sessionId ? { sessionId } : undefined };
  }
}
