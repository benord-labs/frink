import {
  client,
  type ContentBlock,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolCall,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { openSession } from './acp-session';
import { collectChunks, fakeAcpAgent, runnerParams } from './acp-test-fixtures';
import { type AcpRunnerParams, rememberedModelOptions, runAcpAgent } from './index';

const CAN_RESUME = { sessionCapabilities: { resume: {} } };

/** A setting the session offers as a list, named after its category, such as `model`. */
function select(category: string, values: string[]): SessionConfigOption {
  return {
    id: category,
    name: category,
    category,
    type: 'select',
    currentValue: values[0],
    options: values.map((value) => ({ value, name: `Name of ${value}` })),
  };
}

const SETTINGS = [select('model', ['open/one', 'open/two']), select('mode', ['build', 'plan'])];

function errorsOf(chunks: UIMessageChunk[]) {
  return chunks.filter((chunk) => chunk.type === 'error');
}

/** Runs one turn and records, in order, what the client asked the agent, the prompt included. */
async function runTurn(
  setup: Parameters<typeof fakeAcpAgent>[1],
  overrides: Partial<AcpRunnerParams> = {},
) {
  let prompt: ContentBlock[] | undefined;
  const fake = fakeAcpAgent(async (turn) => {
    prompt = turn.prompt;
    fake.requests.push('session/prompt');
  }, setup);
  const chunks = await collectChunks(runAcpAgent(runnerParams(overrides), fake.start));
  return { chunks, prompt, requests: fake.requests };
}

describe('runAcpAgent continuing an earlier conversation', () => {
  it('resumes the earlier session when the agent can', async () => {
    const turn = await runTurn(
      { agentCapabilities: CAN_RESUME },
      { resumeSessionId: 'earlier', freshSessionFallbackPrompt: 'history and hello' },
    );

    expect(turn.requests).toEqual(['session/resume earlier', 'session/prompt']);
    expect(turn.prompt).toEqual([{ type: 'text', text: 'hello' }]);
    expect(turn.chunks).toContainEqual({
      type: 'message-metadata',
      messageMetadata: { sessionId: 'earlier' },
    });
  });

  it('opens a new session with the fallback prompt when resuming fails', async () => {
    const turn = await runTurn(
      { agentCapabilities: CAN_RESUME, resumeFails: true },
      { resumeSessionId: 'earlier', freshSessionFallbackPrompt: 'history and hello' },
    );

    expect(turn.requests).toEqual(['session/resume earlier', 'session/new', 'session/prompt']);
    expect(turn.prompt).toEqual([{ type: 'text', text: 'history and hello' }]);
    expect(errorsOf(turn.chunks)).toEqual([]);
    expect(turn.chunks).toContainEqual({
      type: 'message-metadata',
      messageMetadata: { sessionId: 'fake-session' },
    });
  });

  it.each<[string, string | undefined, string]>([
    ['the fallback prompt', 'history and hello', 'history and hello'],
    ['the prompt when there is no fallback', undefined, 'hello'],
  ])(
    'opens a new session with %s when the agent cannot resume',
    async (_, freshSessionFallbackPrompt, sent) => {
      const turn = await runTurn({}, { resumeSessionId: 'earlier', freshSessionFallbackPrompt });

      expect(turn.requests).toEqual(['session/new', 'session/prompt']);
      expect(turn.prompt).toEqual([{ type: 'text', text: sent }]);
    },
  );
});

describe('runAcpAgent session settings', () => {
  it('opens a session with only its folder, so the agent keeps no rules of its own', async () => {
    const fake = fakeAcpAgent(async () => {});
    await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(fake.opened).toEqual([{ cwd: '/workspace/project', mcpServers: [] }]);
  });

  it('sets the chosen mode and model before the prompt', async () => {
    const turn = await runTurn({ configOptions: SETTINGS }, { model: 'open/two', mode: 'plan' });

    expect(turn.requests).toEqual([
      'session/new',
      'set mode=plan',
      'set model=open/two',
      'session/prompt',
    ]);
    expect(errorsOf(turn.chunks)).toEqual([]);
  });

  it('sets nothing when no model or mode was chosen', async () => {
    const turn = await runTurn({ configOptions: SETTINGS });

    expect(turn.requests).toEqual(['session/new', 'session/prompt']);
  });

  it('sets the chosen mode on a resumed session from the settings its answer lists', async () => {
    const turn = await runTurn(
      { agentCapabilities: CAN_RESUME, configOptions: SETTINGS },
      { resumeSessionId: 'earlier', mode: 'plan' },
    );

    expect(turn.requests).toEqual(['session/resume earlier', 'set mode=plan', 'session/prompt']);
    expect(errorsOf(turn.chunks)).toEqual([]);
  });

  it.each<[string, Partial<AcpRunnerParams>, string]>([
    [
      'a model',
      { model: 'open/three' },
      'Fake Agent no longer offers open/three. Pick another model.',
    ],
    ['a mode', { mode: 'debug' }, 'Fake Agent has no debug mode.'],
  ])('refuses %s the session does not list, before the prompt', async (_, chosen, errorText) => {
    const turn = await runTurn({ configOptions: SETTINGS }, chosen);

    expect(errorsOf(turn.chunks)).toEqual([{ type: 'error', errorText }]);
    expect(turn.requests).toEqual(['session/new']);
  });

  it("remembers each agent's models, groups included, from the session it opened", async () => {
    const grouped: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'open/free',
      options: [
        { group: 'free', name: 'Free', options: [{ value: 'open/free', name: 'Free model' }] },
      ],
    };

    await runTurn({ configOptions: SETTINGS }, { agentId: 'first' });
    await runTurn({ configOptions: [grouped] }, { agentId: 'second' });

    expect(rememberedModelOptions('first')).toEqual([
      { id: 'open/one', name: 'Name of open/one' },
      { id: 'open/two', name: 'Name of open/two' },
    ]);
    expect(rememberedModelOptions('second')).toEqual([{ id: 'open/free', name: 'Free model' }]);
    expect(rememberedModelOptions('never-ran')).toBeUndefined();
  });
});

describe('runAcpAgent while the session opens', () => {
  const UNASKED =
    'The agent did something without asking first, so Frink stopped it. The step shown above already ran.';
  const ACTED: { update: SessionUpdate }[] = [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'execute' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' } },
  ];

  it.each<[string, Parameters<typeof fakeAcpAgent>[1], Partial<AcpRunnerParams>]>([
    ['opening a new session', { reportsOn: { method: 'session/new', messages: ACTED } }, {}],
    [
      'continuing the earlier session',
      { agentCapabilities: CAN_RESUME, reportsOn: { method: 'session/resume', messages: ACTED } },
      { resumeSessionId: 'earlier' },
    ],
    [
      'opening a new session after the earlier one could not continue',
      {
        agentCapabilities: CAN_RESUME,
        resumeFails: true,
        reportsOn: { method: 'session/new', messages: ACTED },
      },
      { resumeSessionId: 'earlier' },
    ],
    [
      'setting the chosen mode',
      {
        configOptions: SETTINGS,
        reportsOn: { method: 'session/set_config_option', messages: ACTED },
      },
      { mode: 'plan' },
    ],
  ])('stops an agent that acts unasked while %s, sending no prompt', async (_, setup, chosen) => {
    const turn = await runTurn(setup, chosen);

    expect(errorsOf(turn.chunks)).toEqual([{ type: 'error', errorText: UNASKED }]);
    expect(turn.requests).not.toContain('session/prompt');
  });

  it('sends no prompt when the agent acts unasked while the reader holds the session id', async () => {
    const fake = fakeAcpAgent(
      async () => {
        fake.requests.push('session/prompt');
      },
      {
        configOptions: SETTINGS,
        reportsOn: { method: 'session/set_config_option', messages: ACTED, afterAnswer: true },
      },
    );

    const chunks: UIMessageChunk[] = [];
    for await (const chunk of runAcpAgent(runnerParams({ mode: 'plan' }), fake.start)) {
      chunks.push(chunk);
      if (chunk.type !== 'message-metadata') continue;
      await vi.waitFor(() => expect(fake.wasDisposed()).toBe(true));
    }

    expect(errorsOf(chunks)).toEqual([{ type: 'error', errorText: UNASKED }]);
    expect(fake.requests).not.toContain('session/prompt');
  });

  it('does not stop an agent that asked while the session opened, was refused, and failed', async () => {
    const write: ToolCall = { toolCallId: 'w1', title: 'write', kind: 'edit', status: 'pending' };
    const turn = await runTurn(
      {
        configOptions: SETTINGS,
        reportsOn: {
          method: 'session/set_config_option',
          messages: [
            { update: { sessionUpdate: 'tool_call', ...write } },
            { permission: write },
            { update: { sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'failed' } },
          ],
        },
      },
      { mode: 'plan' },
    );

    expect(errorsOf(turn.chunks)).toEqual([]);
    expect(turn.requests).toContain('session/prompt');
  });
});

describe('runAcpAgent with attached images', () => {
  const images = [{ data: 'aGk=', mimeType: 'image/png' }];

  it('sends each image as an image block after the text', async () => {
    const turn = await runTurn(
      { agentCapabilities: { promptCapabilities: { image: true } } },
      { images },
    );

    expect(turn.prompt).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    ]);
  });

  it('refuses images an agent cannot take, before opening a session', async () => {
    const turn = await runTurn({}, { images });

    expect(errorsOf(turn.chunks)).toEqual([
      { type: 'error', errorText: "Fake Agent can't take images." },
    ]);
    expect(turn.requests).toEqual([]);
  });
});

describe('runAcpAgent with an agent the user is not signed in to', () => {
  const HINTED =
    'Fake Agent needs you to sign in. Run `fake auth login` in Terminal, then try again.';
  const launch = { ...runnerParams().launch, signInHint: 'fake auth login' };

  it.each<[string, Parameters<typeof fakeAcpAgent>[1], Partial<AcpRunnerParams>]>([
    ['starting', { signedOutOn: ['initialize'] }, {}],
    ['opening a session', { signedOutOn: ['session/new'] }, {}],
    [
      'continuing a session',
      { agentCapabilities: CAN_RESUME, signedOutOn: ['session/resume'] },
      { resumeSessionId: 'earlier' },
    ],
    ['answering the prompt', { signedOutOn: ['session/prompt'] }, {}],
  ])('says how to sign in when the agent asks for it while %s', async (_, setup, chosen) => {
    const turn = await runTurn(setup, { ...chosen, launch });

    expect(errorsOf(turn.chunks)).toEqual([{ type: 'error', errorText: HINTED }]);
  });

  it('keeps what the agent said when it sends the sign-in code with its own words', async () => {
    const turn = await runTurn(
      { signedOutOn: ['session/prompt'], signedOutMessage: 'Rate limit reached' },
      { launch },
    );

    expect(errorsOf(turn.chunks)).toEqual([
      { type: 'error', errorText: `${HINTED} (Fake Agent said: Rate limit reached)` },
    ]);
  });

  it('points to the agent itself when its launch names no sign-in command', async () => {
    const turn = await runTurn({ signedOutOn: ['session/new'] });

    expect(errorsOf(turn.chunks)).toEqual([
      { type: 'error', errorText: 'Fake Agent needs you to sign in with its own app first.' },
    ]);
  });
});

describe('openSession reading the agent version', () => {
  async function versionFrom(
    identity: NonNullable<Parameters<typeof fakeAcpAgent>[1]>['identity'],
  ) {
    const fake = fakeAcpAgent(async () => {}, { identity });
    const { stdio } = fake.start({ ...runnerParams().launch, cwd: '/workspace/project' });
    const connection = client({ name: 'test' }).connect(ndJsonStream(stdio.input, stdio.output));
    const inputs = { ...runnerParams(), hasImages: false, onSessionId: () => {} };
    const opened = await openSession(connection, PROTOCOL_VERSION, inputs);
    connection.close();
    return opened.agentVersion;
  }
  const info = { name: 'fake', version: '' };

  it.each<[string, Parameters<typeof versionFrom>[0], string | undefined]>([
    ['its agent info', { agentInfo: { name: 'fake', version: '1.2.3' } }, '1.2.3'],
    [
      'the extra data of its agent info',
      { agentInfo: { ...info, _meta: { version: '2.0.0' } } },
      '2.0.0',
    ],
    ['the extra data of the answer', { _meta: { agentVersion: '3.1.0' } }, '3.1.0'],
    ['nowhere', { _meta: { version: 4 } }, undefined],
  ])('takes the version from %s', async (_, identity, version) => {
    expect(await versionFrom(identity)).toBe(version);
  });
});
