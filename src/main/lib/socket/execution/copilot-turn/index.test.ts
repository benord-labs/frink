import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COPILOT_TOOLS,
  type CopilotRunnerParams,
  type resolveCopilotLaunch,
  runCopilotAgent,
} from '../../../agent-runner/copilot';
import { fakeCopilotClient } from '../../../agent-runner/copilot/copilot-test-fixtures';
import type { UIMessageChunk } from '../../../claude/types';
import * as database from '../../../db';
import { setPreference } from '../../../db/repos/composer-settings';
import { freshDb } from '../../../db/test-utils/fresh-db';
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

/** A launch that resolves to `result` and a Copilot that records what it was asked to run. */
function fakeDeps(result: LaunchResult = { ok: true, launch: LAUNCH }) {
  const runs: CopilotRunnerParams[] = [];
  const resolve = vi.fn(async () => result);
  return {
    runs,
    resolve,
    deps: {
      resolveCopilotLaunch: resolve,
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

  it("passes the chat's model as saved, the session to continue, its fallback prompt, notes and images", async () => {
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
      model: 'gpt-5.2/medium',
      resumeSessionId: 'cp-session-0',
      prompt: `${reminder}\n\nfix the bug`,
      freshSessionFallbackPrompt: `${reminder}\n\nearlier turns\n\nfix the bug`,
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
    });
  });

  it('keeps a typed slash command first, with its notes after it', async () => {
    const { deps, runs } = fakeDeps();
    const note = 'The user opened the file src/a.ts in the IDE.';
    await collect(startCopilotTurn(turnParams({ prompt: '/review', composerNotes: [note] }), deps));
    expect(runs[0]?.prompt).toBe(`/review\n\n<system-reminder>\n${note}\n</system-reminder>`);
  });

  it('leaves out a Claude or OpenAI model the chat kept from another provider', async () => {
    const { deps, runs } = fakeDeps();
    for (const model of ['sonnet', 'codex-gpt-6-astra-low']) {
      await collect(startCopilotTurn(turnParams({ model }), deps));
    }

    expect(runs.map((run) => run.model)).toEqual([undefined, undefined]);
  });

  it('refuses a model Copilot dropped on every turn, not only the first', async () => {
    vi.spyOn(database, 'getDatabase').mockReturnValue(freshDb());
    setPreference(database.getDatabase(), 'agentModels.copilot', [{ id: 'gpt-old', name: 'Old' }]);
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'copilot turn '));
    const offered = JSON.parse('{"id":"gpt-6","name":"GPT-6","capabilities":{"limits":{}}}');
    const deps = {
      resolveCopilotLaunch: async () => ({
        ok: true as const,
        launch: { ...LAUNCH, configDirectory },
      }),
      runCopilotAgent: (params: CopilotRunnerParams) =>
        runCopilotAgent(params, {
          createClient: () => fakeCopilotClient({ models: [offered] }).client,
        }),
    };
    const errors: string[] = [];
    for (const _turn of [1, 2]) {
      const chunks = await collect(startCopilotTurn(turnParams({ model: 'gpt-old' }), deps));
      errors.push(...chunks.flatMap((chunk) => (chunk.type === 'error' ? [chunk.errorText] : [])));
    }
    await rm(configDirectory, { recursive: true, force: true });

    const refusal = 'GitHub Copilot no longer offers gpt-old. Pick another model.';
    expect(errors).toEqual([refusal, refusal]);
  });
});
