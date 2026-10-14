import { RequestError, type SessionUpdate, type StopReason } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { collectChunks, fakeAcpAgent, runnerParams, says, textOf } from './acp-test-fixtures';
import { runAcpAgent } from './index';

function typesOf(chunks: UIMessageChunk[]): string[] {
  return chunks.map((chunk) => chunk.type);
}

/** One piece of the agent's thinking. */
function thought(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } };
}

describe('runAcpAgent', () => {
  it('streams a text reply between start and finish, and stops the agent', async () => {
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.notify('session/update', { sessionId, update: says('Hello') });
      await client.notify('session/update', { sessionId, update: says(' there') });
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(chunks.slice(0, 2)).toEqual([
      { type: 'start' },
      { type: 'message-metadata', messageMetadata: { sessionId: 'fake-session' } },
    ]);
    expect(textOf(chunks)).toBe('Hello there');
    expect(typesOf(chunks).slice(-2)).toEqual(['text-end', 'finish']);
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: { sessionId: 'fake-session' },
    });
    expect(fake.launches).toEqual([{ ...runnerParams().launch, cwd: '/workspace/project' }]);
    await vi.waitFor(() => expect(fake.wasDisposed()).toBe(true));
  });

  it.each<[string, string]>([
    ['/init', '\u200b/init'],
    ['  /init now', '\u200b  /init now'],
    ['run /init', 'run /init'],
  ])(
    "sends %j as %j, so text never runs as one of the agent's own commands",
    async (prompt, sent) => {
      let received: unknown;
      const fake = fakeAcpAgent(async (turn) => {
        received = turn.prompt;
      });

      await collectChunks(runAcpAgent(runnerParams({ prompt }), fake.start));

      expect(received).toEqual([{ type: 'text', text: sent }]);
    },
  );

  it('cleans up after its launch once the agent has stopped', async () => {
    let stoppedFirst: boolean | undefined;
    const fake = fakeAcpAgent(async () => {});
    const launch = {
      ...runnerParams().launch,
      cleanup: async () => {
        stoppedFirst = fake.wasDisposed();
      },
    };

    await collectChunks(runAcpAgent(runnerParams({ launch }), fake.start));

    await vi.waitFor(() => expect(stoppedFirst).toBe(true));
  });

  it('cleans up its launch when stopped at the first chunk, before the agent starts', async () => {
    const fake = fakeAcpAgent(async () => {});
    const cleanup = vi.fn(async () => {});
    const params = runnerParams({ launch: { ...runnerParams().launch, cleanup } });
    const turn = runAcpAgent(params, fake.start);

    expect((await turn.next()).value).toEqual({ type: 'start' });
    params.abortController.abort();
    await turn.return();

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(fake.launches).toEqual([]);
  });

  it('shows thought as one Thinking card that completes before the text after it', async () => {
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.notify('session/update', { sessionId, update: thought('Let me') });
      await client.notify('session/update', { sessionId, update: thought(' think') });
      await client.notify('session/update', { sessionId, update: says('Done') });
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    const cards = chunks.filter((chunk) => chunk.type === 'tool-input-start');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolName: 'Thinking' });
    const types = typesOf(chunks);
    expect(types.indexOf('tool-output-available')).toBeLessThan(types.indexOf('text-start'));
  });

  it('ends the text before a thought, so the text after it is a new block', async () => {
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.notify('session/update', { sessionId, update: says('before') });
      await client.notify('session/update', { sessionId, update: thought('hmm') });
      await client.notify('session/update', { sessionId, update: says('after') });
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    const blocks = chunks.filter(
      (chunk) => chunk.type === 'text-start' || chunk.type === 'text-end',
    );
    expect(blocks).toEqual([
      { type: 'text-start', id: 'text-1' },
      { type: 'text-end', id: 'text-1' },
      { type: 'text-start', id: 'text-2' },
      { type: 'text-end', id: 'text-2' },
    ]);
    const types = typesOf(chunks);
    expect(types.indexOf('text-end')).toBeLessThan(types.indexOf('tool-input-start'));
  });

  it('reports context use during the turn and token use at its end', async () => {
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'usage_update', used: 7843, size: 200000 },
      });
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 6051, outputTokens: 81, totalTokens: 7933 },
      };
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(chunks).toContainEqual({
      type: 'message-metadata',
      messageMetadata: { contextTokens: 7843, contextWindow: 200000 },
    });
    expect(chunks).toContainEqual({
      type: 'message-metadata',
      messageMetadata: { inputTokens: 6051, outputTokens: 81, totalTokens: 7933 },
    });
  });

  it.each<[StopReason, number]>([
    ['end_turn', 0],
    ['cancelled', 0],
    ['max_tokens', 1],
    ['max_turn_requests', 1],
    ['refusal', 1],
  ])('ends a turn that stopped with %s with %i error', async (stopReason, errors) => {
    const fake = fakeAcpAgent(async () => ({ stopReason }));

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(errors);
    expect(chunks.at(-1)?.type).toBe('finish');
  });

  it('ignores updates it does not show and updates for another session', async () => {
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      });
      await client.notify('session/update', { sessionId: 'child-session', update: says('not ') });
      await client.notify('session/update', { sessionId, update: says('mine') });
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(textOf(chunks)).toBe('mine');
  });
});

describe('runAcpAgent when the agent fails', () => {
  it('reports how the agent process ended when it stops mid-turn', async () => {
    const fake = fakeAcpAgent(async ({ client, sessionId }) => {
      await client.notify('session/update', { sessionId, update: says('partial') });
      fake.crash('exited with code 3: not signed in');
      await new Promise(() => {});
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([
      {
        type: 'error',
        errorText: 'The agent stopped unexpectedly (exited with code 3: not signed in).',
      },
    ]);
    expect(chunks.at(-1)?.type).toBe('finish');
  });

  it("shows the agent's own error while its process is still running", async () => {
    const fake = fakeAcpAgent(async () => {
      throw new RequestError(-32000, 'Rate limit reached');
    });

    const chunks = await collectChunks(
      runAcpAgent(runnerParams(), (launch) => ({
        ...fake.start(launch),
        // Still running, after its launcher wrote a notice to stderr.
        closed: new Promise<void>(() => {}),
        describeExit: () => 'npm warn exec some-agent@1.0.0 will be installed',
      })),
    );

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([
      { type: 'error', errorText: 'Rate limit reached' },
    ]);
  });

  it('gives up on an agent that never finishes starting', async () => {
    vi.useFakeTimers();
    try {
      let disposed = false;
      const silent = () => ({
        stdio: {
          input: new WritableStream<Uint8Array>(),
          output: new ReadableStream<Uint8Array>(),
        },
        closed: new Promise<void>(() => {}),
        describeExit: () => '',
        dispose: async () => {
          disposed = true;
        },
      });

      const collecting = collectChunks(runAcpAgent(runnerParams(), silent));
      await vi.advanceTimersByTimeAsync(60_000);
      const chunks = await collecting;

      expect(chunks).toEqual([
        { type: 'start' },
        { type: 'error', errorText: 'The agent did not finish starting in time.' },
        { type: 'finish', messageMetadata: undefined },
      ]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an agent that speaks another protocol version before opening a session', async () => {
    const fake = fakeAcpAgent(async () => {}, { protocolVersion: 2 });

    const chunks = await collectChunks(runAcpAgent(runnerParams(), fake.start));

    expect(typesOf(chunks)).toEqual(['start', 'error', 'finish']);
    expect(fake.requests).toEqual([]);
  });

  it('turns a launcher that throws into an error chunk', async () => {
    const chunks = await collectChunks(
      runAcpAgent(runnerParams(), () => {
        throw new Error('spawn E2BIG');
      }),
    );

    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'error', errorText: 'spawn E2BIG' },
      { type: 'finish', messageMetadata: undefined },
    ]);
  });
});

describe('runAcpAgent when the user stops the turn', () => {
  it('stops an agent that is still starting, without an error', async () => {
    const abortController = new AbortController();
    const fake = fakeAcpAgent(async () => {});

    const chunks = await collectChunks(
      runAcpAgent(runnerParams({ abortController }), (launch) => {
        // Runs while the agent has yet to answer the first request of the handshake.
        queueMicrotask(() => abortController.abort());
        return fake.start(launch);
      }),
    );

    expect(chunks).toEqual([{ type: 'start' }, { type: 'finish', messageMetadata: undefined }]);
    expect(fake.requests).toEqual([]);
    await vi.waitFor(() => expect(fake.wasDisposed()).toBe(true));
  });

  it('sends no prompt when the turn is stopped while the reader holds the session id', async () => {
    const abortController = new AbortController();
    let prompted = false;
    const fake = fakeAcpAgent(async () => {
      prompted = true;
    });

    const seen: string[] = [];
    for await (const chunk of runAcpAgent(runnerParams({ abortController }), fake.start)) {
      seen.push(chunk.type);
      if (chunk.type === 'message-metadata') abortController.abort();
    }

    expect(seen).toEqual(['start', 'message-metadata', 'finish']);
    await vi.waitFor(() => expect(fake.wasDisposed()).toBe(true));
    expect(prompted).toBe(false);
  });

  it('cancels the agent turn without an error and stops the agent', async () => {
    const abortController = new AbortController();
    let sawCancel = false;
    const fake = fakeAcpAgent(async ({ client, sessionId, cancelled }) => {
      await client.notify('session/update', { sessionId, update: says('partial') });
      abortController.abort();
      await cancelled;
      sawCancel = true;
      return { stopReason: 'cancelled' };
    });

    const chunks = await collectChunks(runAcpAgent(runnerParams({ abortController }), fake.start));

    expect(typesOf(chunks)).not.toContain('error');
    expect(chunks.at(-1)?.type).toBe('finish');
    await vi.waitFor(() => expect(sawCancel).toBe(true));
    await vi.waitFor(() => expect(fake.wasDisposed()).toBe(true));
  });

  it('stops the agent when the reader stops listening with text still open', async () => {
    const abortController = new AbortController();
    const fake = fakeAcpAgent(async ({ client, sessionId, cancelled }) => {
      await client.notify('session/update', { sessionId, update: says('partial') });
      await cancelled;
      return { stopReason: 'cancelled' };
    });

    const seen: string[] = [];
    for await (const chunk of runAcpAgent(runnerParams({ abortController }), fake.start)) {
      seen.push(chunk.type);
      if (chunk.type === 'text-delta') abortController.abort();
      if (abortController.signal.aborted) break;
    }

    expect(seen).toContain('text-delta');
    await vi.waitFor(() => expect(fake.wasDisposed()).toBe(true));
  });
});
