import {
  type AgentContext,
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { UIMessageChunk } from '../../claude/types';
import type { AcpAgentLaunch, AcpAgentProcess } from './acp-process';
import type { AcpRunnerParams } from './index';

type FakeTurn = {
  client: AgentContext;
  sessionId: string;
  /** Settles when the client sends `session/cancel`. */
  cancelled: Promise<void>;
};

/** Plays the agent's side of one prompt; returns the prompt response, `end_turn` by default. */
type FakeTurnScript = (turn: FakeTurn) => Promise<PromptResponse | void>;

/** A scripted ACP agent on the SDK's agent side, joined to the client by in-memory byte streams. */
export function fakeAcpAgent(script: FakeTurnScript, protocolVersion = PROTOCOL_VERSION) {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  let endOutput = () => {};
  const toClient = new TransformStream<Uint8Array, Uint8Array>({
    start: (controller) => {
      endOutput = () => controller.terminate();
    },
  });
  const launches: AcpAgentLaunch[] = [];
  const requests: string[] = [];
  let cancel = () => {};
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  let exit = '';
  let disposed = false;
  agent({ name: 'fake-agent' })
    .onRequest('initialize', () => ({ protocolVersion, agentCapabilities: {} }))
    .onRequest('session/new', () => {
      requests.push('session/new');
      return { sessionId: 'fake-session' };
    })
    .onNotification('session/cancel', () => cancel())
    .onRequest('session/prompt', async ({ params, client }) => {
      const response = await script({ client, sessionId: params.sessionId, cancelled });
      return response ?? { stopReason: 'end_turn' };
    })
    .connect(ndJsonStream(toClient.writable, toAgent.readable));
  const process: AcpAgentProcess = {
    stream: ndJsonStream(toAgent.writable, toClient.readable),
    closed: Promise.resolve(),
    describeExit: () => exit,
    dispose: async () => {
      disposed = true;
    },
  };
  return {
    start: (launch: AcpAgentLaunch) => {
      launches.push(launch);
      return process;
    },
    /** Ends the agent as a crashed process would: its output closes and an exit is on record. */
    crash: (description: string) => {
      exit = description;
      endOutput();
    },
    launches,
    requests,
    wasDisposed: () => disposed,
  };
}

/** Runner params for one turn against a fake agent. */
export function runnerParams(overrides: Partial<AcpRunnerParams> = {}): AcpRunnerParams {
  return {
    launch: { command: 'fake-agent', args: ['acp'], env: {} },
    cwd: '/workspace/project',
    prompt: 'hello',
    abortController: new AbortController(),
    ...overrides,
  };
}

/** One piece of the agent's reply text. */
export function says(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

export function textOf(chunks: UIMessageChunk[]): string {
  return chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('');
}

export async function collectChunks(
  stream: AsyncGenerator<UIMessageChunk, void, undefined>,
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
