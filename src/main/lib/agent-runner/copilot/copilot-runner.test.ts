import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CopilotClientOptions, ProviderConfig } from '@github/copilot-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { collectChunks, textOf } from '../acp/acp-test-fixtures';
import {
  AGENT_IDLE,
  CLIENT_ONLY_POLICY,
  fakeCopilotClient,
  IDLE,
  managedReport,
  says,
  thinks,
  toolEnds,
  toolStarts,
} from './copilot-test-fixtures';
import {
  COPILOT_TOOLS,
  type CopilotRunnerParams,
  disposeAllCopilotClients,
  rememberedCopilotModels,
  runCopilotAgent,
} from './index';

const ACTED_UNASKED =
  'The agent did something without asking first, so Frink stopped it. The step shown above already ran.';
const SIGNED_OUT =
  "GitHub Copilot isn't signed in. Open Terminal, run `copilot login`, finish in your browser, then try again.";
const MANAGED =
  "Your organisation or device manages GitHub Copilot's settings, so Frink can't run it safely.";
const SETTINGS_LOST =
  "GitHub Copilot stopped confirming Frink's safety settings, so Frink stopped it. Any steps shown above already ran.";

let root = '';
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'copilot runner '));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function runnerParams(overrides: Partial<CopilotRunnerParams> = {}): CopilotRunnerParams {
  return {
    launch: {
      command: '/opt/copilot/bin/copilot',
      args: ['--no-remote'],
      env: { HOME: '/Users/someone' },
      configDirectory: path.join(root, 'config'),
      tools: COPILOT_TOOLS,
      versions: { floor: '1.0.96', below: '1.1.0' },
    },
    cwd: '/workspace/project',
    prompt: 'hello',
    abortController: new AbortController(),
    checkApproval: async () => ({ allowed: true }),
    ...overrides,
  };
}

type Fake = ReturnType<typeof fakeCopilotClient>;

function run(fake: Fake, params = runnerParams()) {
  const created: CopilotClientOptions[] = [];
  const chunks = collectChunks(
    runCopilotAgent(params, {
      createClient: (options) => {
        created.push(options);
        return fake.client;
      },
    }),
  );
  return { chunks, created };
}

const typesOf = (chunks: UIMessageChunk[]) => chunks.map((chunk) => chunk.type);
const errorsOf = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((chunk) => (chunk.type === 'error' ? [chunk.errorText] : []));

describe('runCopilotAgent', () => {
  it('streams a text turn between start and finish, then stops the client', async () => {
    const fake = fakeCopilotClient({
      models: [
        {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: {
            supports: { vision: false, reasoningEffort: true },
            limits: { max_context_window_tokens: 1 },
          },
        },
      ],
      turn: ({ emit }) => {
        emit(thinks('Let me see'));
        emit(says('Hello there'));
        emit(IDLE);
      },
    });

    const { chunks, created } = run(fake);
    const result = await chunks;

    expect(typesOf(result)).toEqual([
      'start',
      'message-metadata',
      'tool-input-start',
      'tool-input-available',
      'tool-input-available',
      'tool-output-available',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(result[1]).toEqual({
      type: 'message-metadata',
      messageMetadata: { sessionId: 'copilot-session' },
    });
    expect(textOf(result)).toBe('Hello there');
    expect(result.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: { sessionId: 'copilot-session' },
    });
    expect(created).toEqual([
      {
        connection: {
          kind: 'stdio',
          path: '/opt/copilot/bin/copilot',
          args: ['--no-remote'],
          env: { HOME: '/Users/someone' },
        },
        workingDirectory: '/workspace/project',
      },
    ]);
    expect(fake.sent).toEqual([{ prompt: 'hello', attachments: [] }]);
    expect(fake.opened[0]?.config.configDirectory).toBe(path.join(root, 'config'));
    await vi.waitFor(() => expect(fake.calls).toEqual(['start', 'stop']));
    expect(rememberedCopilotModels()).toEqual([{ id: 'gpt-5', name: 'GPT-5', effort: true }]);
  });

  it('shows an allowed command as a card from start to finish', async () => {
    const asked: string[] = [];
    const fake = fakeCopilotClient({
      turn: async ({ emit, preToolUse }) => {
        emit(toolStarts('call-1', 'bash', { command: 'ls' }));
        await preToolUse('bash', { command: 'ls' });
        emit(toolEnds('call-1', true, 'a.txt'));
        emit(IDLE);
      },
    });
    const params = runnerParams({
      checkApproval: async (request) => {
        asked.push(request.toolName);
        return { allowed: true };
      },
    });

    const result = await run(fake, params).chunks;

    expect(asked).toEqual(['Bash']);
    expect(
      result.filter((chunk) => 'toolCallId' in chunk && chunk.toolCallId === 'call-1'),
    ).toEqual([
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'Bash' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
      { type: 'tool-output-available', toolCallId: 'call-1', output: { output: 'a.txt' } },
    ]);
    expect(errorsOf(result)).toEqual([]);
  });

  it('ends the turn when the agent is done, though a command it started still runs', async () => {
    const fake = fakeCopilotClient({
      turn: ({ emit }) => {
        emit(says('Started the server'));
        emit(AGENT_IDLE);
      },
    });

    const result = await run(fake).chunks;

    expect(textOf(result)).toBe('Started the server');
    await vi.waitFor(() => expect(fake.calls).toEqual(['start', 'stop']));
  });

  it('continues the earlier session when Copilot still has it', async () => {
    const fake = fakeCopilotClient();
    const params = runnerParams({
      resumeSessionId: 'earlier',
      freshSessionFallbackPrompt: 'history',
    });

    const result = await run(fake, params).chunks;

    expect(fake.opened.map(({ how }) => how)).toEqual(['resume']);
    expect(fake.sent[0]?.prompt).toBe('hello');
    expect(result.at(-1)).toEqual({ type: 'finish', messageMetadata: { sessionId: 'earlier' } });
  });

  it('sends the history fallback in a new session when the earlier one is gone', async () => {
    const fake = fakeCopilotClient({ resumeFails: true });
    const params = runnerParams({
      resumeSessionId: 'earlier',
      freshSessionFallbackPrompt: 'history',
    });

    await run(fake, params).chunks;

    expect(fake.opened.map(({ how }) => how)).toEqual(['resume', 'create']);
    expect(fake.sent[0]?.prompt).toBe('history');
  });

  it('turns Plan mode on when asked', async () => {
    const fake = fakeCopilotClient();

    await run(fake, runnerParams({ mode: 'plan' })).chunks;

    expect(await fake.session.rpc.mode.get()).toBe('plan');
  });

  it('sends images as attachments', async () => {
    const fake = fakeCopilotClient();
    const images = [{ data: 'aGk=', mimeType: 'image/png' }];

    await run(fake, runnerParams({ images })).chunks;

    expect(fake.sent[0]?.attachments).toEqual([
      { type: 'blob', data: 'aGk=', mimeType: 'image/png' },
    ]);
  });

  it('ends the turn with the reason when a check fails, sends nothing and stops the client', async () => {
    const fake = fakeCopilotClient({ auth: { isAuthenticated: false } });

    const result = await run(fake).chunks;

    expect(errorsOf(result)).toEqual([SIGNED_OUT]);
    expect(fake.sent).toEqual([]);
    expect(result.at(-1)).toEqual({ type: 'finish', messageMetadata: undefined });
    await vi.waitFor(() => expect(fake.calls).toContain('stop'));
  });

  it.each([
    [
      'an organisation layer appears',
      managedReport({ ...CLIENT_ONLY_POLICY, serverManaged: true }),
      MANAGED,
    ],
    [
      'the safety settings are no longer confirmed',
      managedReport({ ...CLIENT_ONLY_POLICY, bypassPermissionsDisabled: false }),
      SETTINGS_LOST,
    ],
    [
      'an organisation plugin starts installing',
      { ...IDLE, type: 'session.managed_plugin_progress', data: {} },
      MANAGED,
    ],
  ])('stops the turn and Copilot when %s mid-turn', async (_name, report, errorText) => {
    const fake = fakeCopilotClient({
      turn: ({ emit }) => {
        emit(says('Working'));
        // SAFETY: a report this SDK release has no type for yet; Copilot sends it as plain JSON.
        emit(report as typeof IDLE);
        emit(says(' on'));
      },
    });

    const result = await run(fake).chunks;

    expect(errorsOf(result)).toEqual([errorText]);
    expect(textOf(result)).toBe('Working');
    await vi.waitFor(() => expect(fake.calls).toEqual(['start', 'abort', 'stop']));
  });

  it('stops the turn and Copilot when a finished step was never allowed', async () => {
    const fake = fakeCopilotClient({
      turn: ({ emit }) => {
        emit(toolStarts('call-1', 'bash', { command: 'touch x' }));
        emit(toolEnds('call-1', true));
        emit(says('More'));
      },
    });

    const result = await run(fake).chunks;

    expect(typesOf(result).slice(-4)).toEqual([
      'tool-input-available',
      'tool-output-available',
      'error',
      'finish',
    ]);
    expect(errorsOf(result)).toEqual([ACTED_UNASKED]);
    expect(textOf(result)).toBe('');
    await vi.waitFor(() => expect(fake.calls).toEqual(['start', 'abort', 'stop']));
  });

  it('aborts the session when the user stops, then stops the client', async () => {
    const abortController = new AbortController();
    const fake = fakeCopilotClient({
      turn: ({ emit }) => {
        emit(says('Partial'));
        abortController.abort();
        emit(says(' ignored'));
      },
    });

    const result = await run(fake, runnerParams({ abortController })).chunks;

    expect(textOf(result)).toBe('Partial');
    expect(errorsOf(result)).toEqual([]);
    await vi.waitFor(() => expect(fake.calls).toEqual(['start', 'abort', 'stop']));
  });

  it('ends the turn and stops Copilot when the user stops before Copilot takes the message', async () => {
    const fake = fakeCopilotClient({ sendHangs: true });
    const abortController = new AbortController();
    const pending = run(fake, runnerParams({ abortController })).chunks;
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));

    abortController.abort();

    expect(typesOf(await pending)).toEqual(['start', 'message-metadata', 'finish']);
    await vi.waitFor(() => expect(fake.calls).toEqual(['start', 'abort', 'stop']));
  });

  it('starts nothing for a turn stopped before it began', async () => {
    const fake = fakeCopilotClient();
    const abortController = new AbortController();
    abortController.abort();

    const { chunks, created } = run(fake, runnerParams({ abortController }));

    expect(typesOf(await chunks)).toEqual(['start', 'finish']);
    expect(created).toEqual([]);
  });

  it('force-stops a client that does not stop within a moment', async () => {
    const fake = fakeCopilotClient({ stopHangs: true });

    await run(fake).chunks;

    await vi.waitFor(() => expect(fake.calls).toEqual(['start', 'stop', 'forceStop']), {
      timeout: 3_000,
    });
  });

  it('refuses a step Copilot asks about after the turn has ended', async () => {
    const fake = fakeCopilotClient();

    await run(fake).chunks;

    expect(await fake.play.preToolUse('view', { path: '/workspace/project/a.txt' })).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: "This turn has ended, so Frink didn't run this step.",
    });
  });

  it('passes the admission seams to the session: a scripted model and a wrapped hook', async () => {
    const fake = fakeCopilotClient();
    const provider: ProviderConfig = { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1' };

    await collectChunks(
      runCopilotAgent(runnerParams(), {
        createClient: () => fake.client,
        provider,
        gateWrapper: () => () => undefined,
      }),
    );

    expect(fake.opened[0]?.config.provider).toBe(provider);
    expect(await fake.play.preToolUse('bash', { command: 'ls' })).toBeUndefined();
  });

  it('stops a live client when Frink quits', async () => {
    const fake = fakeCopilotClient({ turn: () => {} });
    const params = runnerParams();
    const pending = run(fake, params).chunks;
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));

    await disposeAllCopilotClients();

    expect(fake.calls).toEqual(['start', 'stop']);
    params.abortController.abort();
    await pending;
  });
});
