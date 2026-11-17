import { setTimeout as delay } from 'node:timers/promises';
import type { ClientConnection, ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';
import log from 'electron-log';
import { createThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import { ChunkQueue } from '../codex/chunk-queue';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import { completeTurnChunks, makeChunkSink } from '../codex/codex-stream-chunks';
import { type CommandLedger, createCommandLedger } from './acp-command-ledger';
import { answerPermissionRequest, CANCELLED, questionForTool } from './acp-permissions';
import { type AcpAgentLaunch, type AcpAgentProcess, startAcpAgentProcess } from './acp-process';
import { openSession, SignInRequired } from './acp-session';
import type { KnownToolCall } from './acp-tool-calls';
import {
  createAcpTurnState,
  mapPromptResponse,
  mapSessionUpdate,
  unaskedAction,
} from './acp-updates';

/** How long a cancelled agent gets to record the cancelled turn before it is stopped. */
const CANCEL_GRACE_MS = 2000;
/** How long a dropped connection waits for the process to report why it ended. */
const EXIT_REPORT_MS = 1000;
export const ACTED_UNASKED_TEXT =
  'The agent did something without asking first, so Frink stopped it. The step shown above already ran.';
const BLOCKED_COMMAND_TEXT =
  'Frink blocked a command the agent did not ask about and stopped this chat.';
/** Agents' own commands that would let them act without asking. */
const WIDENING_COMMAND = /^\/(?:allow-all|permissions|autopilot|yolo|always-approve)(?=\s|$)/i;

export type AcpRunnerParams = {
  /** The agent's ACP command line; it runs in `cwd` and must make the agent ask before it acts. */
  launch: Omit<AcpAgentLaunch, 'cwd'>;
  /** The provider id; keys the models remembered for it. */
  agentId: string;
  /** The agent's name in messages, such as 'OpenCode'. */
  agentName: string;
  cwd: string;
  prompt: string;
  /** The agent's session from this chat's last turn, continued when the agent can. */
  resumeSessionId?: string;
  /** Sent instead of `prompt` when that session could not be continued, so history is not lost. */
  freshSessionFallbackPrompt?: string;
  /** A value the session lists under its `model` setting. */
  model?: string;
  /** A value the session lists under its `mode` setting, such as `plan`. */
  mode?: string;
  images?: { data: string; mimeType: string }[];
  abortController: AbortController;
  /** Frink's permission gate. It must settle when the turn ends for any reason, not only a stop. */
  checkApproval: CodexApprovalCheck;
};

type AcpSdk = typeof import('@agentclientprotocol/sdk');
let acpSdk: Promise<AcpSdk> | undefined;

/** The protocol library is ESM-only and the main bundle is CommonJS, so it loads on first use. */
function loadAcpSdk(): Promise<AcpSdk> {
  acpSdk ??= import('@agentclientprotocol/sdk');
  return acpSdk;
}

type AgentLink = { agent?: AcpAgentProcess; connection?: ClientConnection };

function signInText({ agentName, launch: { signInHint } }: AcpRunnerParams, said: string): string {
  const ask = signInHint
    ? `${agentName} needs you to sign in. Run \`${signInHint}\` in Terminal, then try again.`
    : `${agentName} needs you to sign in with its own app first.`;
  // The agent's own words are kept, in case it used the sign-in code for something else.
  return /^authentication required\.?$/i.test(said.trim())
    ? ask
    : `${ask} (${agentName} said: ${said})`;
}

/** Why the turn failed: a sign-in, how the agent process ended, else the error itself. */
async function failureText(
  error: Error,
  { agent, connection }: AgentLink,
  params: AcpRunnerParams,
): Promise<string> {
  if (SignInRequired.safeParse(error).success) return signInText(params, error.message);
  // An agent's output closes a moment before its exit is reported, so wait for the reason.
  const waitMs = connection?.signal.aborted ? EXIT_REPORT_MS : 0;
  const ended = await Promise.race([
    agent?.closed.then(() => true),
    delay(waitMs, false, { ref: false }),
  ]);
  // The stderr of an agent that is still running may be only a notice, such as a download.
  const exit = ended ? (agent?.describeExit() ?? '') : '';
  return exit ? `The agent stopped unexpectedly (${exit}).` : error.message;
}

/** Stops the agent once its turn has ended or the grace period ran out, then tidies its launch. */
async function stopAgent(
  agent: AcpAgentProcess | undefined,
  turnEnded: Promise<void>,
  launch: Pick<AcpAgentLaunch, 'cleanup'>,
  ledger: CommandLedger | undefined,
): Promise<void> {
  try {
    if (!agent) return;
    await Promise.race([turnEnded, delay(CANCEL_GRACE_MS, undefined, { ref: false })]);
    await agent.dispose();
  } finally {
    // Also when the agent would not stop: what it was allowed must not outlive the turn.
    await ledger?.clear();
    await launch.cleanup?.();
  }
}

/** The call a report ends or starts afresh, so no command allowed for it may run any more. */
function retiredCallId(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate === 'tool_call') return update.toolCallId;
  if (update.sessionUpdate !== 'tool_call_update') return undefined;
  return update.status === 'completed' || update.status === 'failed'
    ? update.toolCallId
    : undefined;
}

/** Text that starts with `/` would run as one of the agent's own commands, not reach the model. */
function promptText(text: string): string {
  return text.trimStart().startsWith('/') ? `\u200b${text}` : text;
}

/** The message, or its fallback when the earlier session was lost, then any attached images. */
function promptBlocks(params: AcpRunnerParams, lostHistory: boolean): ContentBlock[] {
  const text = lostHistory ? (params.freshSessionFallbackPrompt ?? params.prompt) : params.prompt;
  const images = (params.images ?? []).map(({ data, mimeType }): ContentBlock => ({
    type: 'image',
    data,
    mimeType,
  }));
  return [{ type: 'text', text: promptText(text) }, ...images];
}

/** Run a single turn against an agent speaking ACP over stdio and stream UI chunks. */
export async function* runAcpAgent(
  params: AcpRunnerParams,
  startAgent = startAcpAgentProcess,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const { signal } = params.abortController;
  const { rules, commandLedger } = params.launch;

  const queue = new ChunkQueue();
  const openTextIds = new Set<string>();
  const thinking = createThinkingEmitter();
  const emit = makeChunkSink(queue, openTextIds, thinking);
  const turn = createAcpTurnState();
  const ledger = commandLedger ? createCommandLedger(commandLedger) : undefined;
  // Aborted once the turn can take no more answers: the user stopped it, or the prompt settled.
  const turnOver = new AbortController();
  const link: AgentLink = {};
  let sessionId: string | undefined;
  // While the session opens any session is this turn's, even one it could not continue.
  const watches = (from: string) => sessionId === undefined || from === sessionId;
  // Set when the turn is stopped for acting unasked, so a later failure cannot hide why.
  let stopText: string | undefined;
  let turnEnded = Promise.resolve();
  const onAbort = () => {
    turnOver.abort();
    queue.finish();
    if (!sessionId) link.connection?.close();
    else void link.connection?.agent.notify('session/cancel', { sessionId }).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  // An action that never reached Frink's gate ends the turn, and the agent at once.
  const stopActingUnasked = (toolCall: KnownToolCall) => {
    if (turnOver.signal.aborted) return;
    log.warn('[ACP] The agent finished an action it never asked about; stopping the turn');
    const wasCommand =
      toolCall.kind === 'execute' || questionForTool(rules, toolCall.tool) === 'Bash';
    const errorText = ledger && wasCommand ? BLOCKED_COMMAND_TEXT : ACTED_UNASKED_TEXT;
    stopText = errorText;
    emit({ type: 'error', errorText });
    onAbort();
    // Logged by the stop that follows the turn, which waits on the same promise.
    void link.agent?.dispose(0).catch(() => {});
  };
  const permissionTurn = {
    state: turn,
    rules,
    cwd: params.cwd,
    checkApproval: params.checkApproval,
    turnOver: turnOver.signal,
    ledger,
    emit,
  };

  try {
    // Inside the try: a reader that stops at this chunk still gets the launch cleaned up.
    yield { type: 'start' };
    signal.throwIfAborted();
    const widening = WIDENING_COMMAND.exec(params.prompt.trim())?.[0];
    if (widening) {
      const reason = 'it would let the agent act without asking you.';
      throw new Error(`Frink doesn't send ${widening} to ${params.agentName}: ${reason}`);
    }
    const { client, ndJsonStream, PROTOCOL_VERSION } = await loadAcpSdk();
    signal.throwIfAborted();
    link.agent = startAgent({ ...params.launch, cwd: params.cwd });
    const connection = client({ name: 'frink' })
      // Registered first, so an update reaches the chat before the answer that ends its turn.
      .onNotification('session/update', ({ params: { sessionId: from, update } }) => {
        if (!watches(from)) return;
        mapSessionUpdate(update, turn).forEach(emit);
        const retired = retiredCallId(update);
        if (retired !== undefined) void ledger?.release(retired);
        const acted = unaskedAction(update, turn, rules.quietTools);
        if (acted) stopActingUnasked(acted);
      })
      .onRequest('session/request_permission', async ({ params: request }) => {
        if (request.sessionId !== sessionId || turnOver.signal.aborted) {
          // Refused while the session opens, the call still asked, so its failure is no stop.
          if (watches(request.sessionId)) turn.asked.add(request.toolCall.toolCallId);
          return CANCELLED;
        }
        return answerPermissionRequest(request, permissionTurn);
      })
      .connect(ndJsonStream(link.agent.stdio.input, link.agent.stdio.output));
    link.connection = connection;
    const opened = await openSession(connection, PROTOCOL_VERSION, {
      ...params,
      hasImages: Boolean(params.images?.length),
    });
    sessionId = opened.sessionId;
    turnOver.signal.throwIfAborted();
    yield { type: 'message-metadata', messageMetadata: { sessionId } };
    // Checked again: the turn may have been stopped while the reader held the chunk above.
    turnOver.signal.throwIfAborted();
    turnEnded = connection.agent
      .request('session/prompt', {
        sessionId,
        prompt: promptBlocks(params, opened.lostHistory),
      })
      .then((response) => mapPromptResponse(response).forEach(emit))
      .catch(async (error: Error) => {
        // A turn that was stopped, by the user or for acting unasked, needs no further error.
        if (!turnOver.signal.aborted) {
          emit({ type: 'error', errorText: await failureText(error, link, params) });
        }
      })
      .finally(() => {
        turnOver.abort();
        queue.finish();
      });
    yield* queue.drain();
  } catch (error) {
    // A turn stopped before its prompt keeps what was queued, its reason included.
    queue.finish();
    yield* queue.drain();
    const stopped = signal.aborted || turnOver.signal.aborted;
    if (!stopped && error instanceof Error) {
      const text = await failureText(error, link, params);
      // A stop for acting unasked can land while the text is read: its reason wins.
      yield { type: 'error', errorText: stopText ?? text };
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    turnOver.abort();
    // Before the first yield: a reader that stops listening never resumes this generator.
    void stopAgent(link.agent, turnEnded, params.launch, ledger).catch((error) =>
      log.warn('[ACP] Agent did not stop', error),
    );
    yield* completeTurnChunks(thinking, openTextIds);
    yield { type: 'finish', messageMetadata: sessionId ? { sessionId } : undefined };
  }
}
