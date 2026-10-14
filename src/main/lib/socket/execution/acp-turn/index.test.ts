import { describe, expect, it, vi } from 'vitest';
import type { AcpRunnerParams, resolveAcpLaunch } from '../../../agent-runner/acp';
import type { UIMessageChunk } from '../../../claude/types';
import { startAcpTurn } from '.';

type LaunchResult = Awaited<ReturnType<typeof resolveAcpLaunch>>;

const LAUNCH = {
  command: '/usr/local/bin/opencode',
  args: ['acp'],
  env: {},
  rules: { toolQuestions: {}, ignoredInputKeys: [], quietTools: [] },
};

/** A launch that resolves to `result` and an agent that records what it was asked to run. */
function fakeDeps(result: LaunchResult = { ok: true, launch: LAUNCH }) {
  const runs: AcpRunnerParams[] = [];
  const resolve = vi.fn(async (..._args: Parameters<typeof resolveAcpLaunch>) => result);
  return {
    runs,
    resolve,
    deps: {
      resolveAcpLaunch: resolve,
      rememberedModelOptions: (_agentId: string) => [
        { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      ],
      async *runAcpAgent(params: AcpRunnerParams): AsyncGenerator<UIMessageChunk, void, undefined> {
        runs.push(params);
        yield { type: 'start' };
        yield { type: 'finish', messageMetadata: { sessionId: 'oc-session-1' } };
      },
    },
  };
}

type TurnParams = Parameters<typeof startAcpTurn>[0];

function turnParams(overrides: Partial<TurnParams> = {}): TurnParams {
  return {
    providerId: 'opencode',
    projectPath: '/tmp/project',
    prompt: 'fix the bug',
    mode: 'agent',
    images: [],
    composerNotes: [],
    abortController: new AbortController(),
    checkApproval: async () => ({ allowed: true }),
    ...overrides,
  };
}

async function collect(stream: AsyncGenerator<UIMessageChunk, void, undefined>) {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('startAcpTurn', () => {
  it('runs the resolved launch in the chat folder and streams what the agent sends', async () => {
    const { deps, runs, resolve } = fakeDeps();
    const chunks = await collect(
      startAcpTurn(turnParams({ configRoot: '/tmp/main-checkout' }), deps),
    );

    expect(resolve).toHaveBeenCalledWith('opencode', '/tmp/project', {
      configRoot: '/tmp/main-checkout',
    });
    expect(chunks.map((chunk) => chunk.type)).toEqual(['start', 'finish']);
    expect(runs[0]).toMatchObject({
      launch: LAUNCH,
      agentId: 'opencode',
      agentName: 'OpenCode',
      cwd: '/tmp/project',
      prompt: 'fix the bug',
    });
  });

  it('shows why the agent could not start, under its name', async () => {
    const reason = "Frink can't find OpenCode on this computer.";
    const { deps, runs } = fakeDeps({ ok: false, reason });

    await expect(collect(startAcpTurn(turnParams(), deps))).rejects.toThrow(
      `OpenCode didn't start. ${reason}`,
    );
    expect(runs).toEqual([]);
  });

  it('refuses a chat with no folder before starting anything', async () => {
    const { deps, resolve } = fakeDeps();

    await expect(collect(startAcpTurn(turnParams({ projectPath: '' }), deps))).rejects.toThrow(
      'OpenCode needs a folder to work in.',
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses Debug mode before starting anything', async () => {
    const { deps, resolve } = fakeDeps();

    await expect(collect(startAcpTurn(turnParams({ mode: 'debug' }), deps))).rejects.toThrow(
      "Debug mode isn't available for OpenCode yet. Switch to Agent or Plan.",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['plan', 'plan'],
    ['agent', 'build'],
  ] as const)('runs a %s turn in the agent’s %s mode, every turn', async (mode, agentMode) => {
    const { deps, runs } = fakeDeps();
    await collect(startAcpTurn(turnParams({ mode }), deps));
    expect(runs[0]?.mode).toBe(agentMode);
  });

  it('refuses Plan mode for an agent that has none', async () => {
    const { deps, resolve } = fakeDeps();

    await expect(
      collect(startAcpTurn(turnParams({ providerId: 'grok', mode: 'plan' }), deps)),
    ).rejects.toThrow("Plan mode isn't available for Grok yet. Switch to Agent.");
    expect(resolve).not.toHaveBeenCalled();
  });

  it('passes the model, the session to continue, its fallback prompt and the images', async () => {
    const { deps, runs } = fakeDeps();
    await collect(
      startAcpTurn(
        turnParams({
          model: 'anthropic/claude-sonnet-4-5',
          resumeSessionId: 'oc-session-0',
          freshSessionFallbackPrompt: 'earlier turns\n\nfix the bug',
          images: [{ base64Data: 'aGk=', mediaType: 'image/png' }],
        }),
        deps,
      ),
    );

    expect(runs[0]).toMatchObject({
      model: 'anthropic/claude-sonnet-4-5',
      resumeSessionId: 'oc-session-0',
      freshSessionFallbackPrompt: 'earlier turns\n\nfix the bug',
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
    });
  });

  it('puts notes on attached files ahead of the message and its fallback', async () => {
    const { deps, runs } = fakeDeps();
    const note = 'The user opened the file src/a.ts in the IDE.';
    await collect(
      startAcpTurn(
        turnParams({ composerNotes: [note], freshSessionFallbackPrompt: 'history\n\nfix the bug' }),
        deps,
      ),
    );

    const reminder = `<system-reminder>\n${note}\n</system-reminder>`;
    expect(runs[0]?.prompt).toBe(`${reminder}\n\nfix the bug`);
    expect(runs[0]?.freshSessionFallbackPrompt).toBe(`${reminder}\n\nhistory\n\nfix the bug`);
  });

  it("sends no model the agent hasn't listed, so it starts on its own default", async () => {
    const { deps, runs } = fakeDeps();
    await collect(startAcpTurn(turnParams({ model: 'sonnet' }), deps));
    await collect(
      startAcpTurn(turnParams({ model: 'anthropic/claude-sonnet-4-5' }), {
        ...deps,
        rememberedModelOptions: () => undefined,
      }),
    );

    expect(runs.map((run) => run.model)).toEqual([undefined, undefined]);
  });
});
