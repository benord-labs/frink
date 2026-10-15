import { constants, existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { collectChunks, textOf } from '../acp/acp-test-fixtures';
import type { CodexApprovalRequest } from '../codex/codex-events';
import {
  fakeCursorHost,
  type FakePlay,
  hookCall,
  recordingLock,
  sdk,
} from './cursor-test-fixtures';
import {
  CURSOR_TOOL_NAMES,
  type CursorRunnerParams,
  cursorAgentOptions,
  cursorHostEnv,
  disposeAllCursorHosts,
  runCursorAgent,
} from './index';

const ACTED_UNASKED =
  'The agent did something without asking first, so Frink stopped it. The step shown above already ran.';
const SIGNED_OUT =
  "Cursor isn't signed in. Choose Sign in to Cursor, finish in your browser, then try again.";
const PLAN_REQUIRED =
  'Cursor needs a paid plan to work in Frink. Upgrade to Cursor Pro or higher, then try again.';
const RUN_FAILED = 'Cursor ran into a problem and stopped this turn. Try again.';
const NOT_LOADED = "Cursor didn't load Frink's safety check, so Frink stopped it.";
const CHANGED = 'Cursor changed how it asks Frink, so Frink stopped it.';
const TURN_OVER = "This turn has ended, so Frink didn't run this step.";
const CURSOR_STOPPED =
  'Cursor stopped unexpectedly, so this turn ended. Any steps shown above already ran.';
const NOT_STARTED = "Frink couldn't start Cursor, so this turn didn't run.";

let root = '';
let chat = 0;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cursor runner '));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type Fake = ReturnType<typeof fakeCursorHost>;
type Recorder = ReturnType<typeof recordingLock>;

/** Each call gets a new chat folder, so turns of different tests never wait on each other. */
function runnerParams(overrides: Partial<CursorRunnerParams> = {}): CursorRunnerParams {
  chat += 1;
  const home = path.join(root, `chat ${chat}`, 'home');
  return {
    launch: {
      sdkEntry: '/sdk/index.js',
      hostPath: '/resources/cursor-host.mjs',
      env: cursorHostEnv({ PATH: '/usr/bin', SHELL: '/bin/zsh' }, home),
      home,
      storeDir: path.join(root, `chat ${chat}`, 'store'),
      realHome: path.join(root, 'real home'),
      userDirs: {},
      ripgrep: '/sdk-platform/bin/rg',
      tools: CURSOR_TOOL_NAMES,
      hookVersions: ['1.0.0'],
    },
    cwd: root,
    prompt: 'hello',
    abortController: new AbortController(),
    checkApproval: async () => ({ allowed: true }),
    ...overrides,
  };
}

function run(fake: Fake, params = runnerParams(), recorder: Recorder = recordingLock()) {
  return collectChunks(runCursorAgent(params, { forkHost: fake.forkHost, lock: recorder.lock }));
}

const typesOf = (chunks: UIMessageChunk[]) => chunks.map((chunk) => chunk.type);
const SIGNED_OUT_ERROR = {
  type: 'error',
  errorText: SIGNED_OUT,
  debugInfo: { category: 'CURSOR_SIGNED_OUT' },
};
const errorsOf = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((chunk) => (chunk.type === 'error' ? [chunk.errorText] : []));
const lastLock = (recorder: Recorder) => recorder.calls.at(-1)?.[0];
const finished = (play: FakePlay) => play.post({ type: 'result', status: 'finished' });

describe('runCursorAgent', () => {
  it('streams a text turn between start and finish, with the agent as the session', async () => {
    const fake = fakeCursorHost({
      turn: async (play) => {
        play.sdk(sdk.status('RUNNING'));
        await play.hook(hookCall('beforeSubmitPrompt', { prompt: 'hello' }));
        play.sdk(sdk.thinks('Let me see'));
        play.sdk(sdk.says('Hello there'));
        finished(play);
      },
    });

    const chunks = await run(fake);

    expect(typesOf(chunks)).toEqual([
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
    expect(chunks[1]).toEqual({
      type: 'message-metadata',
      messageMetadata: { sessionId: 'agent-1' },
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: { sessionId: 'agent-1' } });
    expect(textOf(chunks)).toBe('Hello there');
  });

  it('asks Frink before a command, then shows its card and output', async () => {
    const asked: CodexApprovalRequest[] = [];
    const answers: unknown[] = [];
    const fake = fakeCursorHost({
      turn: async (play) => {
        await play.hook(hookCall('beforeSubmitPrompt'));
        const input = { command: 'ls', cwd: '', timeout: 30000 };
        answers.push(
          await play.hook(
            hookCall('preToolUse', { tool_name: 'Shell', tool_input: input, tool_use_id: 'u1' }),
          ),
        );
        play.sdk(sdk.runs('call-1', 'shell', { command: 'ls', timeout: 30000 }));
        const result = { status: 'success', value: { stdout: 'a.ts\n' } };
        play.sdk(sdk.ran('call-1', 'shell', { command: 'ls', timeout: 30000 }, result));
        finished(play);
      },
    });
    const params = runnerParams({
      checkApproval: async (request) => {
        asked.push(request);
        return { allowed: true };
      },
    });

    const chunks = await run(fake, params);

    expect(asked).toEqual([{ toolName: 'Bash', input: { command: 'ls' } }]);
    expect(answers).toEqual([{ permission: 'allow' }]);
    expect(chunks).toContainEqual({
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    expect(chunks).toContainEqual({
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: { output: 'a.ts\n' },
    });
    expect(errorsOf(chunks)).toEqual([]);
  });

  it('sends one set of options, the prompt, images and Plan mode to the host', async () => {
    const fake = fakeCursorHost();
    const params = runnerParams({
      mode: 'plan',
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
      model: { id: 'gpt-5', params: [{ id: 'reasoning_effort', value: 'high' }] },
    });

    await run(fake, params);

    expect(fake.forks).toEqual([
      expect.objectContaining({
        hostPath: '/resources/cursor-host.mjs',
        sdkEntry: '/sdk/index.js',
        cwd: root,
      }),
    ]);
    expect(fake.forks[0].env.HOME).toBe(params.launch.home);
    expect(fake.received[0]).toEqual({
      type: 'start',
      options: cursorAgentOptions({
        cwd: root,
        storeDir: params.launch.storeDir,
        tools: CURSOR_TOOL_NAMES,
        model: params.model,
      }),
      message: { text: 'hello', images: [{ data: 'aGk=', mimeType: 'image/png' }] },
      mode: 'plan',
    });
  });

  it('continues an earlier agent in its folder, with the fallback prompt for when it is gone', async () => {
    const first = runnerParams();
    await run(fakeCursorHost(), first);
    const fake = fakeCursorHost({ resumeFails: true });
    const params = {
      ...first,
      resumeSessionId: 'agent-1',
      freshSessionFallbackPrompt: 'hello, with the chat so far',
    };

    const chunks = await run(fake, params);

    expect(fake.received[0]).toMatchObject({
      type: 'start',
      resumeAgentId: 'agent-1',
      fallbackText: 'hello, with the chat so far',
      message: { text: 'hello' },
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: { sessionId: 'agent-1' } });
  });

  it('starts a new agent with the chat so far once the chat has moved to another folder', async () => {
    const first = runnerParams();
    await run(fakeCursorHost(), first);
    const moved = path.join(root, 'moved');
    const fake = fakeCursorHost();
    const later = { resumeSessionId: 'agent-1', freshSessionFallbackPrompt: 'the chat so far' };

    await run(fake, { ...first, ...later, cwd: moved });
    await run(fake, { ...first, ...later, cwd: moved });

    const [movedStart, nextStart] = fake.received.filter(({ type }) => type === 'start');
    expect(movedStart).toMatchObject({
      message: { text: 'the chat so far' },
      resumeAgentId: undefined,
    });
    expect(nextStart).toMatchObject({ message: { text: 'hello' }, resumeAgentId: 'agent-1' });
  });

  it('ends with the sign-in text, and never starts an agent, when Cursor is signed out', async () => {
    const fake = fakeCursorHost({ auth: 'logged-out' });

    const chunks = await run(fake);

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([SIGNED_OUT_ERROR]);
    expect(fake.received.map((message) => message.type)).not.toContain('start');
  });

  it('tags a key Cursor turns down mid-turn, so the chat offers Sign in', async () => {
    const fake = fakeCursorHost({
      turn: (play) =>
        play.post({ type: 'error', text: 'Invalid API key', code: 'unauthenticated' }),
    });

    const chunks = await run(fake);

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([SIGNED_OUT_ERROR]);
  });

  it('shows the paid-plan text when Cursor refuses the plan', async () => {
    const fake = fakeCursorHost({
      turn: (play) =>
        play.post({ type: 'error', text: 'Not available for free users', code: 'plan_required' }),
    });

    expect(errorsOf(await run(fake))).toEqual([PLAN_REQUIRED]);
  });

  it.each([
    [{ message: 'Model overloaded' }, RUN_FAILED],
    [{ message: 'Invalid API key', code: 'unauthenticated' }, SIGNED_OUT],
    [{ message: 'Not available', code: 'plan_required' }, PLAN_REQUIRED],
  ])('shows a failed run %o in plain words', async (error, shown) => {
    const fake = fakeCursorHost({
      turn: (play) => play.post({ type: 'result', status: 'error', error }),
    });

    expect(errorsOf(await run(fake))).toEqual([shown]);
  });

  it.each([
    ['a thought', sdk.thinks('hmm')],
    ['a tool call', sdk.runs('call-1', 'read', { path: '/x' })],
  ])("stops the turn when %s comes before Frink's check was seen", async (_name, message) => {
    const recorder = recordingLock();
    const fake = fakeCursorHost({
      turn: (play) => {
        play.sdk(sdk.status('RUNNING'));
        play.sdk(message);
        play.sdk(sdk.says('more'));
      },
    });

    const chunks = await run(fake, runnerParams(), recorder);

    expect(errorsOf(chunks)).toEqual([NOT_LOADED]);
    expect(textOf(chunks)).toBe('');
    await vi.waitFor(() => expect(fake.received.at(-1)).toEqual({ type: 'cancel' }));
  });

  it.each([
    ['before', '{"type":"sdk","message":null}'],
    ['after', '{"type":"sdk","message":{"type":"usage"}}'],
  ])("ends the turn when an unreadable message comes %s Frink's check", async (when, json) => {
    const fake = fakeCursorHost({
      turn: async (play) => {
        if (when === 'after') await play.hook(hookCall('beforeSubmitPrompt'));
        play.raw(json);
        play.sdk(sdk.says('more'));
      },
    });

    const chunks = await run(fake);

    expect(errorsOf(chunks)).toEqual([CURSOR_STOPPED]);
    expect(textOf(chunks)).toBe('');
  });

  it('ends in plain words, and unlocks, when Cursor cannot be started', async () => {
    const recorder = recordingLock();
    const forkHost = () => {
      throw new Error('spawn ENOENT /private/var/folders/x/cursor-host.mjs');
    };

    const chunks = await collectChunks(
      runCursorAgent(runnerParams(), { forkHost, lock: recorder.lock }),
    );

    expect(errorsOf(chunks)).toEqual([NOT_STARTED]);
    await vi.waitFor(() => expect(lastLock(recorder)).toBe(false));
  });

  it.each([
    ['a command Frink never allowed', 'rm -rf build', ''],
    ['an allowed command in another folder', 'ls', '/elsewhere'],
  ])('stops the turn and the host after %s ran', async (_name, command, workingDirectory) => {
    const recorder = recordingLock();
    const fake = fakeCursorHost({
      turn: async (play) => {
        await play.hook(hookCall('beforeSubmitPrompt'));
        const asked = { tool_name: 'Shell', tool_input: { command: 'ls', cwd: '' } };
        await play.hook(hookCall('preToolUse', asked));
        const done = { status: 'success', value: { exitCode: 0 } };
        play.sdk(sdk.ran('call-1', 'shell', { command, workingDirectory }, done));
      },
      onCancel: () => {},
    });

    const chunks = await run(fake, runnerParams(), recorder);

    expect(errorsOf(chunks)).toEqual([ACTED_UNASKED]);
    expect(fake.received.at(-1)).toEqual({ type: 'cancel' });
    await vi.waitFor(() => expect(fake.kills()).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(lastLock(recorder)).toBe(false));
  });

  it('stops an unasked rerun after the allowed run of the same command ended in an error', async () => {
    const fake = fakeCursorHost({
      turn: async (play) => {
        await play.hook(hookCall('beforeSubmitPrompt'));
        const asked = { tool_name: 'Shell', tool_input: { command: 'rm x', cwd: '' } };
        await play.hook(hookCall('preToolUse', asked));
        const failed = { status: 'error', error: { message: 'exit 1' } };
        play.sdk(sdk.ran('call-1', 'shell', { command: 'rm x' }, failed, 'error'));
        const done = { status: 'success', value: { exitCode: 0 } };
        play.sdk(sdk.ran('call-2', 'shell', { command: 'rm x' }, done));
      },
      onCancel: () => {},
    });

    expect(errorsOf(await run(fake, runnerParams(), recordingLock()))).toEqual([ACTED_UNASKED]);
  });

  it('stops once however many calls carry an untested hook version', async () => {
    const answers: unknown[] = [];
    const fake = fakeCursorHost({
      turn: async (play) => {
        const untested = hookCall('beforeSubmitPrompt', { cursor_version: '9.9.9' });
        answers.push(await play.hook(untested), await play.hook(untested));
      },
      onCancel: () => {},
    });

    const chunks = await run(fake);

    expect(errorsOf(chunks)).toEqual([CHANGED]);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers).toEqual([
      { permission: 'deny', user_message: CHANGED },
      { permission: 'deny', user_message: CHANGED },
    ]);
  });

  it('on Stop, cancels the run, refuses late hook calls, then kills the host', async () => {
    const recorder = recordingLock();
    const late: unknown[] = [];
    const controller = new AbortController();
    const fake = fakeCursorHost({
      turn: async (play) => {
        await play.hook(hookCall('beforeSubmitPrompt'));
        controller.abort();
      },
      onCancel: async (play) => {
        late.push(
          await play.hook(
            hookCall('preToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } }),
          ),
        );
      },
    });

    const chunks = await run(fake, runnerParams({ abortController: controller }), recorder);

    expect(chunks.at(-1)?.type).toBe('finish');
    await vi.waitFor(() => expect(late).toEqual([{ permission: 'deny', user_message: TURN_OVER }]));
    expect(fake.kills()).toBe(0);
    await vi.waitFor(() => expect(fake.kills()).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(lastLock(recorder)).toBe(false));
  });

  it("keeps the chat's home locked until a killed host has exited", async () => {
    const controller = new AbortController();
    const fake = fakeCursorHost({
      turn: async (play) => {
        await play.hook(hookCall('beforeSubmitPrompt'));
        controller.abort();
      },
      onCancel: () => {},
      exitAfterKillMs: 300,
    });
    const recorder = recordingLock();
    const unlockSawExit: boolean[] = [];
    const watched: Recorder = {
      ...recorder,
      lock: (on, paths) => {
        if (!on) unlockSawExit.push(fake.exited());
        return recorder.lock(on, paths);
      },
    };

    await run(fake, runnerParams({ abortController: controller }), watched);

    await vi.waitFor(() => expect(fake.kills()).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(lastLock(recorder)).toBe(false), { timeout: 3000 });
    expect(unlockSawExit.at(-1)).toBe(true);
  });

  it("unlocks the chat's home and removes the gate after a finished or failed turn", async () => {
    for (const turn of [finished, (play: FakePlay) => play.post({ type: 'error', text: 'boom' })]) {
      const recorder = recordingLock();
      const params = runnerParams();
      await run(fakeCursorHost({ turn }), params, recorder);

      await vi.waitFor(() => expect(lastLock(recorder)).toBe(false));
      const locked = recorder.calls.find(([on]) => on)?.[1] ?? [];
      const gateDir = path.dirname(locked[0]);
      await vi.waitFor(() => expect(existsSync(gateDir)).toBe(false));
      await access(path.join(params.launch.home, '.cursor', 'hooks.json'), constants.W_OK);
    }
  });

  it("gives the agent's commands back the user's folders the host env leaves out", async () => {
    const params = runnerParams();
    params.launch.userDirs = { XDG_CONFIG_HOME: '/home/me/my config' };
    await run(fakeCursorHost({ turn: finished }), params);

    const profile = await readFile(path.join(params.launch.home, '.bash_profile'), 'utf8');
    expect(profile).toContain("XDG_CONFIG_HOME='/home/me/my config'");
  });

  it('closes the gate even when the home cannot be unlocked', async () => {
    const recorder = recordingLock();
    const lock: Recorder['lock'] = async (on, paths) => {
      if (!on && lastLock(recorder)) throw new Error('Not permitted');
      await recorder.lock(on, paths);
    };
    const plays: FakePlay[] = [];
    const fake = fakeCursorHost({
      turn: (play) => {
        plays.push(play);
        finished(play);
      },
    });

    await collectChunks(runCursorAgent(runnerParams(), { forkHost: fake.forkHost, lock }));

    await vi.waitFor(() => expect(plays[0].hook(hookCall('beforeSubmitPrompt'))).rejects.toThrow());
    const locked = recorder.calls.find(([on]) => on)?.[1] ?? [];
    await recorder.lock(false, locked);
    await rm(path.dirname(locked[0]), { recursive: true, force: true });
  });

  it("starts a chat's next turn only once the last one has unlocked", async () => {
    const recorder = recordingLock();
    const first = runnerParams();
    const second = { ...runnerParams(), launch: first.launch };
    const fake = fakeCursorHost({ turn: () => {} });

    const firstChunks = run(fake, first, recorder);
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));
    const secondChunks = run(fake, second, recorder);
    await delay(50);
    expect(fake.forks).toHaveLength(1);

    first.abortController.abort();
    await vi.waitFor(() => expect(fake.forks).toHaveLength(2), { timeout: 3000 });
    second.abortController.abort();
    await Promise.all([firstChunks, secondChunks]);
  });

  it('kills a live host and unlocks its home when Frink quits', async () => {
    const recorder = recordingLock();
    const fake = fakeCursorHost({ turn: () => {}, onCancel: () => {} });
    const chunks = run(fake, runnerParams(), recorder);
    await vi.waitFor(() => expect(fake.received).toHaveLength(1));

    await disposeAllCursorHosts();

    expect(fake.kills()).toBe(1);
    expect(lastLock(recorder)).toBe(false);
    expect((await chunks).at(-1)?.type).toBe('finish');
  });
});

describe('cursorAgentOptions', () => {
  it('gives create and resume the same tools and settings, and none of the unsafe ones', () => {
    const options = cursorAgentOptions({ cwd: '/p', storeDir: '/s', tools: CURSOR_TOOL_NAMES });

    expect(options).toEqual({
      model: { id: 'default' },
      tools: CURSOR_TOOL_NAMES,
      local: { cwd: '/p', settingSources: ['user'] },
      storeDir: '/s',
    });
  });
});
