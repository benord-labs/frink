import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SDKModel, SettingSource } from '@cursor/sdk';
import { utilityProcess } from 'electron';
import log from 'electron-log';
import { createThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import { ACTED_UNASKED_TEXT } from '../acp/acp-runner';
import { ChunkQueue } from '../codex/chunk-queue';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import { completeTurnChunks, makeChunkSink } from '../codex/codex-stream-chunks';
import {
  type CursorModel,
  type CursorSdkMessage,
  createCursorEventState,
  mapCursorMessage,
} from './cursor-events';
import { createCursorGate } from './cursor-gate';
import { openGateSocket } from './cursor-gate-socket';
import { type HomeLock, prepareCursorHome } from './cursor-home';
import { saveCursorModels } from './cursor-models';

/** How long the host gets to exit on its own before it is killed. */
const STOP_GRACE_MS = 1500;
export const SIGNED_OUT =
  "Cursor isn't signed in. Choose Sign in to Cursor, finish in your browser, then try again.";
export const PLAN_REQUIRED =
  'Cursor needs a paid plan to work in Frink. Upgrade to Cursor Pro or higher, then try again.';
const NOT_LOADED = "Cursor didn't load Frink's safety check, so Frink stopped it.";
const CURSOR_STOPPED =
  'Cursor stopped unexpectedly, so this turn ended. Any steps shown above already ran.';
const RUN_FAILED = 'Cursor ran into a problem and stopped this turn. Try again.';
// Cursor's own error codes that have a plain cause and fix; any other code shows RUN_FAILED.
const PLAIN_ERRORS = new Map([
  ['plan_required', PLAN_REQUIRED],
  ['unauthenticated', SIGNED_OUT],
]);
const NOT_STARTED = "Frink couldn't start Cursor, so this turn didn't run.";
// Messages Cursor may send before it asks Frink's check about the prompt.
const BEFORE_CANARY = new Set(['status', 'system']);

// Keyed by the SDK's SettingSource, so a source Cursor adds or removes fails typecheck here.
// Only the chat's private home loads: it holds the hook that asks Frink before every change.
export const CURSOR_SETTING_SOURCES = {
  user: 'loaded',
  // A repo's own hooks and MCP servers could switch Frink's check off.
  project: 'hidden-by-design',
  // Cursor's team, device-management and plugin settings have never been tested inside Frink.
  team: 'not-yet-delivered',
  mdm: 'not-yet-delivered',
  plugins: 'not-yet-delivered',
  // Every source at once, the repo's included.
  all: 'hidden-by-design',
} as const satisfies Record<SettingSource, 'loaded' | 'hidden-by-design' | 'not-yet-delivered'>;

/** Agent options the host passes to both create and resume; it opens the store from storeDir. */
export type HostAgentOptions = {
  model: CursorModel;
  tools: string[];
  local: { cwd: string; settingSources: ['user'] };
  storeDir: string;
};
type CursorUserMessage = { text: string; images?: { data: string; mimeType: string }[] };
type RunError = { message: string; code?: string };

/** What Frink sends the host once it reports its sign-in: a turn, a model list or a sign-in. */
export type CursorHostRequest =
  | {
      type: 'start';
      options: HostAgentOptions;
      message: CursorUserMessage;
      mode?: 'plan';
      resumeAgentId?: string;
      /** Sent instead of the message's text when the earlier agent cannot be resumed. */
      fallbackText?: string;
    }
  | { type: 'models' }
  | { type: 'login' }
  | { type: 'cancel' };

/** What the host posts back, the SDK's own messages wrapped in `sdk`. */
export type CursorHostMessage =
  | { type: 'auth'; status: string }
  | { type: 'agent'; agentId: string; resumed: boolean }
  | { type: 'models'; list: SDKModel[] }
  | { type: 'sdk'; message: CursorSdkMessage }
  | { type: 'result'; status: 'finished' | 'error' | 'cancelled'; error?: RunError }
  | { type: 'error'; text: string; code?: string }
  /** A page of Cursor's own sign-in to open in the browser. */
  | { type: 'open'; url: string };

export type ForkHost = (
  input: { hostPath: string; sdkEntry: string; env: Record<string, string>; cwd: string },
  events: { message(message: CursorHostMessage): void; exit(): void },
) => { send(request: CursorHostRequest): void; kill(): void };

type CursorLaunch = {
  sdkEntry: string;
  hostPath: string;
  env: Record<string, string>;
  home: string;
  storeDir: string;
  realHome: string;
  /** The user's XDG folders the host env leaves out, given back to the agent's commands. */
  userDirs: Record<string, string>;
  /** The ripgrep Cursor's search runs, so Frink's gate can ask it what a search walks. */
  ripgrep: string;
  tools: readonly string[];
  hookVersions: readonly string[];
};

export type CursorRunnerParams = {
  launch: CursorLaunch;
  cwd: string;
  prompt: string;
  /** Sent instead of `prompt` when the earlier agent could not be continued. */
  freshSessionFallbackPrompt?: string;
  resumeSessionId?: string;
  model?: CursorModel;
  mode?: 'plan';
  images?: { data: string; mimeType: string }[];
  abortController: AbortController;
  checkApproval: CodexApprovalCheck;
};

export type CursorRunnerDeps = {
  forkHost?: ForkHost;
  lock?: HomeLock;
};

export const forkUtilityHost: ForkHost = ({ hostPath, sdkEntry, env, cwd }, events) => {
  const child = utilityProcess.fork(hostPath, [sdkEntry], {
    env,
    cwd,
    serviceName: 'Frink Cursor',
    stdio: 'ignore',
  });
  child.on('message', events.message);
  child.once('exit', events.exit);
  return { send: (request) => child.postMessage(request, []), kill: () => child.kill() };
};

// Turns not yet released, and each chat's latest turn, so a chat's next turn starts once it unlocks.
const liveTurns = new Map<CursorTurn, Promise<void>>();
const lastTurnOfChat = new Map<string, Promise<void>>();

/** The options one chat's agent is created and resumed with. */
export function cursorAgentOptions(input: {
  cwd: string;
  storeDir: string;
  tools: readonly string[];
  model?: CursorModel;
}): HostAgentOptions {
  return {
    model: input.model ?? { id: 'default' },
    tools: [...input.tools],
    local: { cwd: input.cwd, settingSources: ['user'] },
    storeDir: input.storeDir,
  };
}

/** Cursor's error in plain words; its own text goes only to the log. */
function errorText(error: RunError | undefined): string {
  log.warn(`[Cursor] The run failed: ${error?.code ?? 'no code'} ${error?.message ?? ''}`);
  return PLAIN_ERRORS.get(error?.code ?? '') ?? RUN_FAILED;
}

// Cursor recalls a chat only in the folder it began in, so each chat notes its agent's folder.
const folderNote = (launch: CursorLaunch) => path.join(path.dirname(launch.storeDir), 'folder');

/** One turn's stream, gate, private home and host process, and the ways the turn can end. */
class CursorTurn {
  readonly queue = new ChunkQueue();
  readonly openTextIds = new Set<string>();
  readonly thinking = createThinkingEmitter();
  private readonly emit = makeChunkSink(this.queue, this.openTextIds, this.thinking);
  private readonly shown = createCursorEventState();
  // Aborted once the turn takes no more answers, so a late hook call is refused.
  private readonly over = new AbortController();
  readonly ended = new Promise<void>((resolve) => {
    this.over.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  readonly gate: ReturnType<typeof createCursorGate>;
  agentId?: string;
  private resumeId?: string;
  private noted?: Promise<void>;
  private host?: ReturnType<ForkHost>;
  private readonly hostExited = new AbortController();
  private socket?: Awaited<ReturnType<typeof openGateSocket>>;
  private unlock?: () => Promise<void>;

  constructor(
    private readonly params: CursorRunnerParams,
    private readonly deps: CursorRunnerDeps,
  ) {
    const { home, realHome, ripgrep, hookVersions } = params.launch;
    this.gate = createCursorGate({
      cwd: params.cwd,
      home,
      realHome,
      ripgrep,
      hookVersions,
      checkApproval: params.checkApproval,
      turnOver: this.over.signal,
      onStop: (reason) => this.halt(reason),
    });
  }

  readonly end = (): void => {
    this.over.abort();
    this.queue.finish();
  };

  /** Ends the turn with an error; safe to call again once it has ended. */
  halt(text: string): void {
    if (this.over.signal.aborted) return;
    log.warn(`[Cursor] Stopping the turn: ${text}`);
    // Tagged so the chat offers a button to Cursor's connect page.
    const signIn = text === SIGNED_OUT ? { debugInfo: { category: 'CURSOR_SIGNED_OUT' } } : {};
    this.emit({ type: 'error', errorText: text, ...signIn });
    this.end();
  }

  /** Opens the gate, prepares and locks the private home, then starts the host. */
  async begin(previous: Promise<void> | undefined): Promise<void> {
    await previous;
    if (this.over.signal.aborted) return;
    const { launch, cwd, resumeSessionId } = this.params;
    const folder = await readFile(folderNote(launch), 'utf8').catch(() => undefined);
    if (folder === cwd) this.resumeId = resumeSessionId;
    this.socket = await openGateSocket((body) => this.gate.answer(body));
    const prepared = await prepareCursorHome(
      { home: launch.home, realHome: launch.realHome, userDirs: launch.userDirs, ...this.socket },
      { lock: this.deps.lock },
    );
    if (!prepared.ok) return this.halt(prepared.reason);
    this.unlock = prepared.unlock;
    if (this.over.signal.aborted) return;
    const forkHost = this.deps.forkHost ?? forkUtilityHost;
    this.host = forkHost(
      { hostPath: launch.hostPath, sdkEntry: launch.sdkEntry, env: launch.env, cwd },
      {
        message: (message) => {
          // Saved even once the turn has ended, as the list is not part of the turn.
          if (message.type === 'models') return saveCursorModels(message.list);
          try {
            this.onMessage(message);
          } catch (error) {
            log.warn('[Cursor] Could not read a host message', error);
            this.halt(CURSOR_STOPPED);
          }
        },
        exit: () => {
          this.hostExited.abort();
          this.halt(CURSOR_STOPPED);
        },
      },
    );
  }

  private start(): void {
    const { params, resumeId } = this;
    const { launch, images, freshSessionFallbackPrompt: fallback } = params;
    const { storeDir, tools } = launch;
    // A chat that moved folder gets a new agent, sent the chat so far.
    const moved = params.resumeSessionId !== undefined && !resumeId;
    const message: CursorUserMessage = { text: (moved && fallback) || params.prompt };
    if (images?.length) message.images = images;
    this.host?.send({
      type: 'start',
      options: cursorAgentOptions({ cwd: params.cwd, storeDir, tools, model: params.model }),
      message,
      mode: params.mode,
      resumeAgentId: resumeId,
      fallbackText: resumeId && fallback,
    });
  }

  private onMessage(message: CursorHostMessage): void {
    if (this.over.signal.aborted) return;
    switch (message.type) {
      case 'auth':
        return message.status === 'logged-in' ? this.start() : this.halt(SIGNED_OUT);
      case 'agent':
        this.agentId = message.agentId;
        this.noted = writeFile(folderNote(this.params.launch), this.params.cwd).catch((error) =>
          log.warn("[Cursor] Could not note the chat's folder", error),
        );
        return this.emit({
          type: 'message-metadata',
          messageMetadata: { sessionId: message.agentId },
        });
      case 'sdk':
        return this.onSdkMessage(message.message);
      case 'result':
        return message.status === 'error' ? this.halt(errorText(message.error)) : this.end();
      case 'error':
        return this.halt(errorText({ message: message.text, code: message.code }));
    }
  }

  private onSdkMessage(message: CursorSdkMessage): void {
    // Frink's check sees the prompt before Cursor answers; anything earlier means it did not load.
    if (!this.gate.canarySeen() && !BEFORE_CANARY.has(message.type)) return this.halt(NOT_LOADED);
    mapCursorMessage(message, this.shown).forEach(this.emit);
    // A failed step still uses up its allowance; only a successful one can trip.
    if (message.type === 'tool_call' && message.status !== 'running') {
      const { name, args, result } = message;
      if (this.gate.actedUnasked({ name, args, result })) this.halt(ACTED_UNASKED_TEXT);
    }
  }

  /** Cancels the run, kills the host if it lingers, then unlocks the home and closes the gate. */
  async release(): Promise<void> {
    if (this.host && !this.hostExited.signal.aborted) {
      const exited = once(this.hostExited.signal, 'abort').then(() => true);
      const settled = () => Promise.race([exited, delay(STOP_GRACE_MS, false, { ref: false })]);
      this.host.send({ type: 'cancel' });
      if (!(await settled())) {
        this.host.kill();
        // Stay locked until the killed host is gone, so the chat's next turn never shares the home.
        await settled();
      }
    }
    try {
      await this.noted;
      await this.unlock?.();
    } finally {
      await this.socket?.close();
    }
  }
}

/** Stops every turn still running and waits until each has unlocked, for when Frink quits. */
export async function disposeAllCursorHosts(): Promise<void> {
  const turns = [...liveTurns];
  for (const [turn] of turns) turn.end();
  await Promise.allSettled(turns.map(([, released]) => released));
}

/** Runs one Cursor turn in its own host process through Frink's gate and streams UI chunks. */
export async function* runCursorAgent(
  params: CursorRunnerParams,
  deps: CursorRunnerDeps = {},
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const { signal } = params.abortController;
  const { home } = params.launch;
  yield { type: 'start' };
  const turn = new CursorTurn(params, deps);
  signal.addEventListener('abort', turn.end, { once: true });
  const started = turn.begin(lastTurnOfChat.get(home)).catch((error) => {
    log.warn('[Cursor] Could not start the host', error);
    turn.halt(NOT_STARTED);
  });
  const released = Promise.all([turn.ended, started])
    .then(() => turn.release())
    .catch((error) => log.warn('[Cursor] Did not stop cleanly', error))
    .finally(() => {
      liveTurns.delete(turn);
      if (lastTurnOfChat.get(home) === released) lastTurnOfChat.delete(home);
    });
  liveTurns.set(turn, released);
  lastTurnOfChat.set(home, released);
  try {
    if (signal.aborted) turn.end();
    yield* turn.queue.drain();
  } finally {
    signal.removeEventListener('abort', turn.end);
    turn.end();
    yield* completeTurnChunks(turn.thinking, turn.openTextIds);
    yield {
      type: 'finish',
      messageMetadata: turn.agentId ? { sessionId: turn.agentId } : undefined,
    };
  }
}
