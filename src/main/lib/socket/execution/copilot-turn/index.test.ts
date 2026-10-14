import { describe, expect, it, vi } from 'vitest';
import type {
  CopilotRunnerParams,
  rememberedCopilotModels,
  resolveCopilotLaunch,
} from '../../../agent-runner/copilot';
import { COPILOT_TOOLS } from '../../../agent-runner/copilot';
import type { UIMessageChunk } from '../../../claude/types';
import { startCopilotTurn } from '.';

type LaunchResult = Awaited<ReturnType<typeof resolveCopilotLaunch>>;

const LAUNCH = {
  command: '/usr/local/bin/copilot',
  args: ['--no-remote'],
  env: {},
  configDirectory: '/tmp/frink/copilot/config',
  tools: COPILOT_TOOLS,
  versions: { floor: '1.0.96', below: '1.1.0' },
};

const GPT = { name: 'GPT-5.2', familyId: 'gpt-5.2' };
// As Copilot lists them: one row per effort where the model offers a choice, else one row.
const MODELS: NonNullable<ReturnType<typeof rememberedCopilotModels>> = [
  { ...GPT, id: 'gpt-5.2/medium', effort: 'medium', effortDefault: true },
  { ...GPT, id: 'gpt-5.2/high', effort: 'high' },
  { id: 'auto', name: 'Auto' },
];

/** A launch that resolves to `result` and a Copilot that records what it was asked to run. */
function fakeDeps(result: LaunchResult = { ok: true, launch: LAUNCH }) {
  const runs: CopilotRunnerParams[] = [];
  const resolve = vi.fn(async () => result);
  return {
    runs,
    resolve,
    deps: {
      resolveCopilotLaunch: resolve,
      rememberedCopilotModels: () => MODELS,
      async *runCopilotAgent(
        params: CopilotRunnerParams,
      ): AsyncGenerator<UIMessageChunk, void, undefined> {
        runs.push(params);
        yield { type: 'start' };
        yield { type: 'finish', messageMetadata: { sessionId: 'cp-session-1' } };
      },
    },
  };
}

type TurnParams = Parameters<typeof startCopilotTurn>[0];

function turnParams(overrides: Partial<TurnParams> = {}): TurnParams {
  return {
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

describe('startCopilotTurn', () => {
  it('runs the resolved launch in the chat folder and streams what Copilot sends', async () => {
    const { deps, runs } = fakeDeps();
    const chunks = await collect(startCopilotTurn(turnParams(), deps));

    expect(chunks.map((chunk) => chunk.type)).toEqual(['start', 'finish']);
    expect(runs[0]).toMatchObject({ launch: LAUNCH, cwd: '/tmp/project', prompt: 'fix the bug' });
    expect(runs[0]?.mode).toBeUndefined();
  });

  it('shows why Copilot could not start, under its name', async () => {
    const reason = "Frink can't find GitHub Copilot on this computer.";
    const { deps, runs } = fakeDeps({ ok: false, reason });

    await expect(collect(startCopilotTurn(turnParams(), deps))).rejects.toThrow(
      `GitHub Copilot didn't start. ${reason}`,
    );
    expect(runs).toEqual([]);
  });

  it.each<[Partial<TurnParams>, string]>([
    [{ projectPath: '' }, 'GitHub Copilot needs a folder to work in.'],
    [
      { mode: 'debug' },
      "Debug mode isn't available for GitHub Copilot yet. Switch to Agent or Plan.",
    ],
  ])('refuses %o before starting anything', async (overrides, message) => {
    const { deps, resolve } = fakeDeps();

    await expect(collect(startCopilotTurn(turnParams(overrides), deps))).rejects.toThrow(message);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('runs a Plan turn in Copilot’s plan mode', async () => {
    const { deps, runs } = fakeDeps();
    await collect(startCopilotTurn(turnParams({ mode: 'plan' }), deps));
    expect(runs[0]?.mode).toBe('plan');
  });

  it('passes a listed model, the session to continue, its fallback prompt, notes and images', async () => {
    const { deps, runs } = fakeDeps();
    const note = 'The user opened the file src/a.ts in the IDE.';
    await collect(
      startCopilotTurn(
        turnParams({
          model: 'gpt-5.2/medium',
          resumeSessionId: 'cp-session-0',
          freshSessionFallbackPrompt: 'earlier turns\n\nfix the bug',
          composerNotes: [note],
          images: [{ base64Data: 'aGk=', mediaType: 'image/png' }],
        }),
        deps,
      ),
    );

    const reminder = `<system-reminder>\n${note}\n</system-reminder>`;
    expect(runs[0]).toMatchObject({
      model: 'gpt-5.2',
      resumeSessionId: 'cp-session-0',
      prompt: `${reminder}\n\nfix the bug`,
      freshSessionFallbackPrompt: `${reminder}\n\nearlier turns\n\nfix the bug`,
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
    });
  });

  it('sends the chosen effort with its model, and none for a model without a choice', async () => {
    const { deps, runs } = fakeDeps();
    for (const model of ['gpt-5.2/medium', 'gpt-5.2/high', 'auto']) {
      await collect(startCopilotTurn(turnParams({ model }), deps));
    }

    expect(runs.map(({ model, reasoningEffort }) => [model, reasoningEffort])).toEqual([
      ['gpt-5.2', 'medium'],
      ['gpt-5.2', 'high'],
      ['auto', undefined],
    ]);
  });

  it("sends no model Copilot hasn't listed, so it starts on its own default", async () => {
    const { deps, runs } = fakeDeps();
    await collect(startCopilotTurn(turnParams({ model: 'sonnet' }), deps));
    await collect(
      startCopilotTurn(turnParams({ model: 'gpt-5.2/medium' }), {
        ...deps,
        rememberedCopilotModels: () => undefined,
      }),
    );

    expect(runs.map((run) => [run.model, run.reasoningEffort])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});
