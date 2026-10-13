import {
  type AgentContext,
  agent,
  type ContentBlock,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionOutcome,
  type SessionUpdate,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { UIMessageChunk } from '../../claude/types';
import type { AcpAgentRules } from './acp-permissions';
import type { AcpAgentLaunch, AcpAgentProcess } from './acp-process';
import type { AcpRunnerParams } from './index';

type FakeTurn = {
  client: AgentContext;
  sessionId: string;
  prompt: ContentBlock[];
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
      const { sessionId, prompt } = params;
      const response = await script({ client, sessionId, prompt, cancelled });
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

/** Rules shaped like OpenCode's, which names each tool in the first title of its call. */
export const TEST_RULES: AcpAgentRules = {
  toolQuestions: {
    bash: 'Bash',
    read: 'Read',
    write: 'Edit',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
  },
  ignoredInputKeys: ['directories', 'patterns', 'parentDir', 'numResults', 'provider'],
  quietTools: ['read', 'grep', 'list'],
};

/** Runner params for a turn in which the permission gate denies whatever it is asked. */
export function runnerParams(overrides: Partial<AcpRunnerParams> = {}): AcpRunnerParams {
  return {
    launch: { command: 'fake-agent', args: ['acp'], env: {}, rules: TEST_RULES },
    cwd: '/workspace/project',
    prompt: 'hello',
    abortController: new AbortController(),
    checkApproval: async () => ({ allowed: false, message: 'User denied permission' }),
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

type RecordedMessage = { update: SessionUpdate } | { permission: ToolCallUpdate };
export type RecordedTurn = { messages: RecordedMessage[]; response: PromptResponse };

/** The three options OpenCode 1.19.0 offered on every recorded permission request. */
export const RECORDED_OPTIONS: PermissionOption[] = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];

/** Replays a recorded turn from the agent's side and collects the answers the client gave. */
export function replayTurn(recorded: RecordedTurn) {
  const answers: RequestPermissionOutcome[] = [];
  const script: FakeTurnScript = async ({ client, sessionId }) => {
    for (const message of recorded.messages) {
      if ('update' in message) {
        await client.notify('session/update', { sessionId, update: message.update });
      } else {
        const answer = await client.request('session/request_permission', {
          sessionId,
          toolCall: message.permission,
          options: RECORDED_OPTIONS,
        });
        answers.push(answer.outcome);
      }
    }
    return recorded.response;
  };
  return { script, answers };
}

const PROJECT = '/workspace/project';
const WRITE_ID = 'call_00_19bhuyzkd55mtlhzmjo2vzej';
const WRITE_PATH = `${PROJECT}/hello.txt`;
const REJECTED = 'The user rejected permission to use this specific tool call.';
const REJECTED_CONTENT: ToolCallUpdate['content'] = [
  { type: 'content', content: { type: 'text', text: REJECTED } },
];

/**
 * Turns recorded from OpenCode 1.19.0 on 2026-10-13. The client rejected every request. The
 * project path is replaced; most thought chunks, the command list and usage detail are left out.
 */
export const RECORDED_REJECTED_WRITE: RecordedTurn = {
  messages: [
    {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'prt_1329e2d6b001or6s8G3b5Xqp3i',
        content: { type: 'text', text: 'Simple' },
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: WRITE_ID,
        title: 'write',
        kind: 'edit',
        status: 'pending',
        locations: [],
        rawInput: {},
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: WRITE_ID,
        status: 'in_progress',
        kind: 'edit',
        title: 'write',
        locations: [{ path: WRITE_PATH }],
        rawInput: { filePath: WRITE_PATH, content: 'hi' },
      },
    },
    {
      permission: {
        toolCallId: WRITE_ID,
        title: WRITE_PATH,
        kind: 'edit',
        status: 'pending',
        locations: [{ path: WRITE_PATH }],
        rawInput: {
          filepath: WRITE_PATH,
          diff: `Index: ${WRITE_PATH}\n===================================================================\n--- ${WRITE_PATH}\n+++ ${WRITE_PATH}\n@@ -0,0 +1,1 @@\n+hi\n\\ No newline at end of file\n`,
        },
        content: [{ type: 'diff', path: WRITE_PATH, oldText: '', newText: 'hi' }],
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: WRITE_ID,
        status: 'failed',
        kind: 'edit',
        title: 'write',
        locations: [{ path: WRITE_PATH }],
        rawInput: { filePath: WRITE_PATH, content: 'hi' },
        content: REJECTED_CONTENT,
        rawOutput: { error: REJECTED },
      },
    },
    {
      update: {
        sessionUpdate: 'usage_update',
        used: 7843,
        size: 200000,
        cost: { amount: 0, currency: 'USD' },
      },
    },
  ],
  response: {
    stopReason: 'end_turn',
    usage: { inputTokens: 6051, outputTokens: 81, totalTokens: 7933 },
  },
};

const LS_ID = 'call_00_7h9jp0msgywsipmmxv5th2h4';

/** "Run the command ls": the request repeats the command but not the directory it runs in. */
export const RECORDED_REJECTED_COMMAND: RecordedTurn = {
  messages: [
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: LS_ID,
        title: 'bash',
        kind: 'execute',
        status: 'pending',
        locations: [{ path: PROJECT }],
        rawInput: { cwd: PROJECT },
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: LS_ID,
        status: 'in_progress',
        kind: 'execute',
        title: 'ls',
        locations: [{ path: PROJECT }],
        rawInput: { command: 'ls', cwd: PROJECT },
      },
    },
    {
      permission: {
        toolCallId: LS_ID,
        title: 'ls',
        kind: 'execute',
        status: 'pending',
        locations: [],
        rawInput: { command: 'ls' },
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: LS_ID,
        status: 'failed',
        kind: 'execute',
        title: 'ls',
        locations: [{ path: PROJECT }],
        rawInput: { command: 'ls', cwd: PROJECT },
        content: REJECTED_CONTENT,
        rawOutput: { error: REJECTED },
      },
    },
  ],
  response: { stopReason: 'end_turn' },
};

const LS_ELSEWHERE_ID = 'call_00_whcad6e319gdro5a5zsih60c';

/**
 * From "run ls with the working directory set to /tmp": what OpenCode asks first is not the
 * command but access to a directory outside the project, on the same call id with another kind.
 */
export const RECORDED_OUTSIDE_DIRECTORY: RecordedTurn = {
  messages: [
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: LS_ELSEWHERE_ID,
        title: 'bash',
        kind: 'execute',
        status: 'pending',
        locations: [{ path: PROJECT }],
        rawInput: { cwd: PROJECT },
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: LS_ELSEWHERE_ID,
        status: 'in_progress',
        kind: 'execute',
        title: 'ls',
        locations: [{ path: '/tmp' }],
        rawInput: { command: 'ls', workdir: '/tmp' },
      },
    },
    {
      permission: {
        toolCallId: LS_ELSEWHERE_ID,
        title: 'ls',
        kind: 'other',
        status: 'pending',
        locations: [{ path: '/tmp' }],
        rawInput: { command: 'ls', directories: ['/tmp'], patterns: ['/tmp/*'] },
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: LS_ELSEWHERE_ID,
        status: 'failed',
        kind: 'execute',
        title: 'ls',
        locations: [{ path: '/tmp' }],
        rawInput: { command: 'ls', workdir: '/tmp' },
        content: REJECTED_CONTENT,
        rawOutput: { error: REJECTED },
      },
    },
  ],
  response: { stopReason: 'end_turn' },
};
