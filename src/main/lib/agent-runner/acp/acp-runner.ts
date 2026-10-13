import { setTimeout as delay } from 'node:timers/promises';
import { client, type ClientConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import log from 'electron-log';
import { createThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import { ChunkQueue } from '../codex/chunk-queue';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import { completeTurnChunks, makeChunkSink } from '../codex/codex-stream-chunks';
import { answerPermissionRequest, approvalRequestsFor, CANCELLED } from './acp-permissions';
import { type AcpAgentLaunch, type AcpAgentProcess, startAcpAgentProcess } from './acp-process';
import { describesStepWithoutKind, rememberToolCall } from './acp-tool-calls';
import { createAcpTurnState, mapPromptResponse, mapSessionUpdate } from './acp-updates';

/** Starting an agent may include a first-run download; a prompt itself has no deadline. */
const START_DEADLINE_MS = 60_000;
/** How long a cancelled agent gets to record the cancelled turn before it is stopped. */
const CANCEL_GRACE_MS = 2000;
/** How long a dropped connection waits for the process to report why it ended. */
const EXIT_REPORT_MS = 1000;

export type AcpRunnerParams = {
  /** The agent's ACP command line; it runs in `cwd`. */
  launch: Omit<AcpAgentLaunch, 'cwd'>;
  cwd: string;
  prompt: string;
  abortController: AbortController;
  /** Frink's permission gate. It must settle when the turn ends for any reason, not only a stop. */
  checkApproval: CodexApprovalCheck;
};

/** Runs the ACP handshake and opens a session, closing the connection if that takes too long. */
async function openSession(connection: ClientConnection, cwd: string): Promise<string> {
  const deadline = setTimeout(
    () => connection.close(new Error('The agent did not finish starting in time.')),
    START_DEADLINE_MS,
  );
  try {
    const initialized = await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // Nothing is advertised: the agent uses its own file and terminal tools, which ask first.
      clientCapabilities: {},
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `The agent speaks ACP version ${initialized.protocolVersion}, not ${PROTOCOL_VERSION}.`,
      );
    }
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    return session.sessionId;
  } finally {
    clearTimeout(deadline);
  }
}

type AgentLink = { agent?: AcpAgentProcess; connection?: ClientConnection };

/** Why the turn failed: how the agent process ended when it did, else the error itself. */
async function failureText(error: Error, { agent, connection }: AgentLink): Promise<string> {
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

async function stopAgent(agent: AcpAgentProcess, turnEnded: Promise<void>): Promise<void> {
  await Promise.race([turnEnded, delay(CANCEL_GRACE_MS, undefined, { ref: false })]);
  await agent.dispose();
}

/** Run a single turn against an agent speaking ACP over stdio and stream UI chunks. */
export async function* runAcpAgent(
  params: AcpRunnerParams,
  startAgent = startAcpAgentProcess,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const { signal } = params.abortController;
  yield { type: 'start' };

  const queue = new ChunkQueue();
  const openTextIds = new Set<string>();
  const thinking = createThinkingEmitter();
  const emit = makeChunkSink(queue, openTextIds, thinking);
  const turn = createAcpTurnState();
  // Aborted once the turn can take no more answers: the user stopped it, or the prompt settled.
  const turnOver = new AbortController();
  const link: AgentLink = {};
  let sessionId: string | undefined;
  let turnEnded = Promise.resolve();
  const onAbort = () => {
    turnOver.abort();
    queue.finish();
    if (!sessionId) link.connection?.close();
    else void link.connection?.agent.notify('session/cancel', { sessionId }).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    signal.throwIfAborted();
    link.agent = startAgent({ ...params.launch, cwd: params.cwd });
    const connection = client({ name: 'frink' })
      // Registered first, so an update reaches the chat before the answer that ends its turn.
      .onNotification('session/update', ({ params: notification }) => {
        if (notification.sessionId !== sessionId) return;
        mapSessionUpdate(notification.update, turn).forEach(emit);
      })
      .onRequest('session/request_permission', ({ params: request }) => {
        if (request.sessionId !== sessionId || turnOver.signal.aborted) return CANCELLED;
        // The request joins what earlier updates said: either may hold what the other leaves out.
        const toolCall = rememberToolCall(turn.toolCalls, request.toolCall);
        // An earlier report may describe another step: a request that describes one must name its kind.
        const questions = describesStepWithoutKind(request.toolCall)
          ? []
          : approvalRequestsFor(toolCall);
        if (questions.length === 0) {
          log.warn(
            `[ACP] Refused a ${toolCall.kind ?? 'tool'} call Frink cannot ask its rules about`,
          );
        }
        return answerPermissionRequest(
          questions,
          request.options,
          params.checkApproval,
          turnOver.signal,
        );
      })
      .connect(link.agent.stream);
    link.connection = connection;
    sessionId = await openSession(connection, params.cwd);
    signal.throwIfAborted();
    yield { type: 'message-metadata', messageMetadata: { sessionId } };
    // Checked again: the reader may have stopped the turn while it held the chunk above.
    signal.throwIfAborted();
    turnEnded = connection.agent
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: params.prompt }] })
      .then((response) => mapPromptResponse(response).forEach(emit))
      .catch(async (error: Error) => {
        if (!signal.aborted) emit({ type: 'error', errorText: await failureText(error, link) });
      })
      .finally(() => {
        turnOver.abort();
        queue.finish();
      });
    yield* queue.drain();
  } catch (error) {
    if (!signal.aborted && error instanceof Error) {
      yield { type: 'error', errorText: await failureText(error, link) };
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    turnOver.abort();
    // Before the first yield: a reader that stops listening never resumes this generator.
    if (link.agent) {
      void stopAgent(link.agent, turnEnded).catch((error) =>
        log.warn('[ACP] Agent did not stop', error),
      );
    }
    yield* completeTurnChunks(thinking, openTextIds);
    yield { type: 'finish', messageMetadata: sessionId ? { sessionId } : undefined };
  }
}
