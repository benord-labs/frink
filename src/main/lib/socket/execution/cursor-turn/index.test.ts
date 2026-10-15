import { describe, expect, it, vi } from 'vitest';
import type { CursorRunnerParams, resolveCursorLaunch } from '../../../agent-runner/cursor';
import { CURSOR_TOOL_NAMES } from '../../../agent-runner/cursor';
import type { UIMessageChunk } from '../../../claude/types';
import { startCursorTurn } from '.';

type LaunchResult = Awaited<ReturnType<typeof resolveCursorLaunch>>;

const LAUNCH: CursorRunnerParams['launch'] = {
  sdkEntry: '/sdk/dist/esm/index.js',
  hostPath: '/resources/cursor/cursor-host.mjs',
  env: {},
  home: '/tmp/frink/cursor/chats/chat-1/home',
  storeDir: '/tmp/frink/cursor/chats/chat-1/store',
  realHome: '/Users/me',
  tools: CURSOR_TOOL_NAMES,
  hookVersions: ['1.0.0'],
};

/** A launch that resolves to `result` and a Cursor that records what it was asked to run. */
function fakeDeps(result: LaunchResult = { ok: true, launch: LAUNCH }) {
  const runs: CursorRunnerParams[] = [];
  const resolve = vi.fn(async (_input: { chatKey: string }) => result);
  return {
    runs,
    resolve,
    deps: {
      resolveCursorLaunch: resolve,
      async *runCursorAgent(
        params: CursorRunnerParams,
      ): AsyncGenerator<UIMessageChunk, void, undefined> {
        runs.push(params);
        yield { type: 'start' };
        yield { type: 'finish', messageMetadata: { sessionId: 'agent-1' } };
      },
    },
  };
}

type TurnParams = Parameters<typeof startCursorTurn>[0];

function turnParams(overrides: Partial<TurnParams> = {}): TurnParams {
  return {
    chatKey: 'chat-1',
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

describe('startCursorTurn', () => {
  it("runs the chat's own launch in the chat folder and streams what Cursor sends", async () => {
    const { deps, runs, resolve } = fakeDeps();
    const chunks = await collect(startCursorTurn(turnParams(), deps));

    expect(chunks.map((chunk) => chunk.type)).toEqual(['start', 'finish']);
    expect(resolve).toHaveBeenCalledWith({ chatKey: 'chat-1' });
    expect(runs[0]).toMatchObject({ launch: LAUNCH, cwd: '/tmp/project', prompt: 'fix the bug' });
    expect(runs[0]?.mode).toBeUndefined();
  });

  it('shows why Cursor could not start, under its name', async () => {
    const reason = "Frink can't find Cursor's SDK on this computer.";
    const { deps, runs } = fakeDeps({ ok: false, reason });

    await expect(collect(startCursorTurn(turnParams(), deps))).rejects.toThrow(
      `Cursor didn't start. ${reason}`,
    );
    expect(runs).toEqual([]);
  });

  it.each<[Partial<TurnParams>, string]>([
    [{ projectPath: '' }, 'Cursor needs a folder to work in.'],
    [{ mode: 'debug' }, "Debug mode isn't available for Cursor yet. Switch to Agent or Plan."],
  ])('refuses %o before starting anything', async (overrides, message) => {
    const { deps, resolve } = fakeDeps();

    await expect(collect(startCursorTurn(turnParams(overrides), deps))).rejects.toThrow(message);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('runs a Plan turn in Cursor’s plan mode', async () => {
    const { deps, runs } = fakeDeps();
    await collect(startCursorTurn(turnParams({ mode: 'plan' }), deps));
    expect(runs[0]?.mode).toBe('plan');
  });

  it('passes the agent to continue, its fallback prompt, notes and images, and no model', async () => {
    const { deps, runs } = fakeDeps();
    const note = 'The user opened the file src/a.ts in the IDE.';
    await collect(
      startCursorTurn(
        turnParams({
          model: 'sonnet',
          resumeSessionId: 'agent-0',
          freshSessionFallbackPrompt: 'earlier turns\n\nfix the bug',
          composerNotes: [note],
          images: [{ base64Data: 'aGk=', mediaType: 'image/png' }],
        }),
        deps,
      ),
    );

    const reminder = `<system-reminder>\n${note}\n</system-reminder>`;
    expect(runs[0]).toMatchObject({
      resumeSessionId: 'agent-0',
      prompt: `${reminder}\n\nfix the bug`,
      freshSessionFallbackPrompt: `${reminder}\n\nearlier turns\n\nfix the bug`,
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
    });
    expect(runs[0]?.model).toBeUndefined();
  });
});
