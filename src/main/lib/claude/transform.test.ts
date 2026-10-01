import { describe, expect, it } from 'vitest';
import { partsStateFromChunks } from '../socket/claude-turn-context';
import { createTransformer } from './transform';
import type { UIMessageChunk } from './types';

function collect(gen: Generator<UIMessageChunk>): UIMessageChunk[] {
  return [...gen];
}

describe('createTransformer', () => {
  it('ends a turn whose result is a usage limit with a RATE_LIMIT_SDK error chunk', () => {
    const transform = createTransformer();
    const limit = "You've hit your limit · resets 3pm";
    const chunks = collect(transform({ type: 'result', subtype: 'success', result: limit }));

    expect(chunks.at(-2)?.type).toBe('finish');
    expect(chunks.at(-1)).toEqual({
      type: 'error',
      errorText: limit,
      debugInfo: { category: 'RATE_LIMIT_SDK' },
    });
    const quoted = collect(
      createTransformer()({
        type: 'result',
        subtype: 'success',
        result: `Fixed the "${limit}" copy`,
      }),
    );
    expect(quoted.some((c) => c.type === 'error')).toBe(false);
  });

  it('emits start on first message', () => {
    const transform = createTransformer();
    const chunks = collect(transform({ type: 'system', subtype: 'init' }));
    expect(chunks[0]).toEqual({ type: 'start' });
    expect(chunks[1]).toEqual({ type: 'start-step' });
  });

  it('emits text-start/delta/end for assistant text blocks', () => {
    const transform = createTransformer();
    // Prime with system message to get past start
    collect(transform({ type: 'system', subtype: 'init' }));

    const chunks = collect(
      transform({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
    );

    const textStart = chunks.find((c) => c.type === 'text-start');
    const textDelta = chunks.find((c) => c.type === 'text-delta');
    const textEnd = chunks.find((c) => c.type === 'text-end');
    expect(textStart).toBeDefined();
    expect(textDelta).toBeDefined();
    expect(textEnd).toBeDefined();
    if (textDelta?.type === 'text-delta') {
      expect(textDelta.delta).toBe('Hello');
    }
  });

  describe('user message Array.isArray guard', () => {
    it('processes user message with array content (tool results)', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'result text',
              },
            ],
          },
        }),
      );

      const toolOutput = chunks.find((c) => c.type === 'tool-output-available');
      expect(toolOutput).toBeDefined();
      if (toolOutput?.type === 'tool-output-available') {
        expect(toolOutput.toolCallId).toBe('tool-1');
      }
    });

    it('handles tool_result with is_error flag', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-err',
                content: 'something failed',
                is_error: true,
              },
            ],
          },
        }),
      );

      const errorChunk = chunks.find((c) => c.type === 'tool-output-error');
      expect(errorChunk).toBeDefined();
      if (errorChunk?.type === 'tool-output-error') {
        expect(errorChunk.toolCallId).toBe('tool-err');
        expect(errorChunk.errorText).toBe('something failed');
      }
    });

    it('does not crash when user message content is a string (non-array)', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      // Before the Array.isArray guard, this would attempt to iterate a string
      const chunks = collect(
        transform({
          type: 'user',
          message: { content: 'raw string content' as unknown as Array<unknown> },
        }),
      );

      const toolChunks = chunks.filter(
        (c) => c.type === 'tool-output-available' || c.type === 'tool-output-error',
      );
      expect(toolChunks).toHaveLength(0);
    });

    it('does not crash when user message content is an object (non-array)', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'user',
          message: { content: { text: 'foo' } as unknown as Array<unknown> },
        }),
      );

      const toolChunks = chunks.filter(
        (c) => c.type === 'tool-output-available' || c.type === 'tool-output-error',
      );
      expect(toolChunks).toHaveLength(0);
    });

    it('does not crash when user message content is undefined', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'user',
          message: {},
        }),
      );

      const toolChunks = chunks.filter(
        (c) => c.type === 'tool-output-available' || c.type === 'tool-output-error',
      );
      expect(toolChunks).toHaveLength(0);
    });

    it('does not crash when user message content is null', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'user',
          message: { content: null as unknown as Array<unknown> },
        }),
      );

      const toolChunks = chunks.filter(
        (c) => c.type === 'tool-output-available' || c.type === 'tool-output-error',
      );
      expect(toolChunks).toHaveLength(0);
    });
  });

  describe('result message', () => {
    it('emits metadata and finish on result message', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'result',
          usage: { input_tokens: 100, output_tokens: 50 },
          session_id: 'sess-1',
          total_cost_usd: 0.01,
        }),
      );

      const metadata = chunks.find((c) => c.type === 'message-metadata');
      const finish = chunks.find((c) => c.type === 'finish');
      expect(metadata).toBeDefined();
      expect(finish).toBeDefined();
      if (metadata?.type === 'message-metadata') {
        expect(metadata.messageMetadata.sessionId).toBe('sess-1');
        expect(metadata.messageMetadata.inputTokens).toBe(100);
        expect(metadata.messageMetadata.outputTokens).toBe(50);
        expect(metadata.messageMetadata.totalTokens).toBe(150);
      }
    });
  });

  describe('system messages', () => {
    it('emits session-init on init subtype', () => {
      const transform = createTransformer();
      const chunks = collect(
        transform({
          type: 'system',
          subtype: 'init',
          tools: ['read', 'write'],
          mcp_servers: [{ name: 'test-server', status: 'connected' }],
          plugins: [{ name: 'plugin1', path: '/path' }],
          skills: ['skill1'],
        }),
      );

      const initChunk = chunks.find((c) => c.type === 'session-init');
      expect(initChunk).toBeDefined();
      if (initChunk?.type === 'session-init') {
        expect(initChunk.tools).toEqual(['read', 'write']);
        expect(initChunk.mcpServers).toHaveLength(1);
        expect(initChunk.mcpServers[0].name).toBe('test-server');
        expect(initChunk.skills).toEqual(['skill1']);
      }
    });

    it('emits data-compact for compacting status', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({ type: 'system', subtype: 'status', status: 'compacting' }),
      );

      const compact = chunks.find((c) => c.type === 'data-compact');
      expect(compact).toBeDefined();
      if (compact?.type === 'data-compact') {
        expect(compact.data.state).toBe('input-streaming');
      }
    });

    it('settles the open card on the boundary and reports the trigger', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      const opened = collect(
        transform({ type: 'system', subtype: 'status', status: 'compacting' }),
      ).find((c) => c.type === 'data-compact');

      const chunks = collect(
        transform({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 1000 },
        }),
      );

      const settled = chunks.find((c) => c.type === 'data-compact');
      expect(settled).toBeDefined();
      if (settled?.type === 'data-compact' && opened?.type === 'data-compact') {
        expect(settled.data.state).toBe('output-available');
        expect(settled.data.trigger).toBe('auto');
        // Same id — the SDK upserts a data part by id, so this settles the open card
        // instead of appending a second one.
        expect(settled.id).toBe(opened.id);
      }
    });

    it('resolves the Compact card when compaction fails instead of leaving it spinning', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      const opened = collect(
        transform({ type: 'system', subtype: 'status', status: 'compacting' }),
      ).find((c) => c.type === 'data-compact');

      const chunks = collect(
        transform({ type: 'system', subtype: 'status', compact_result: 'failed' }),
      );

      const failed = chunks.find((c) => c.type === 'data-compact');
      expect(failed).toBeDefined();
      if (failed?.type === 'data-compact' && opened?.type === 'data-compact') {
        expect(failed.data.state).toBe('output-error');
        expect(failed.id).toBe(opened.id);
      }
    });

    it('ignores a failure result when no compaction is open', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({ type: 'system', subtype: 'status', compact_result: 'failed' }),
      );

      expect(chunks.find((c) => c.type === 'data-compact')).toBeUndefined();
    });
  });

  describe('endToolInput JSON parse safety', () => {
    it('handles valid JSON tool input normally', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-valid', name: 'Read' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"path":"/foo.ts"}' },
          },
        }),
      );
      const chunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      const toolInput = chunks.find((c) => c.type === 'tool-input-available');
      expect(toolInput).toBeDefined();
      if (toolInput?.type === 'tool-input-available') {
        expect(toolInput.input).toEqual({ path: '/foo.ts' });
      }
    });

    it('emits partial salvage on malformed stream JSON then supersedes with assistant repair', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-broken', name: 'Write' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"path":"/foo.ts","content":"trun' },
          },
        }),
      );
      const stopChunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      const partial = stopChunks.find((c) => c.type === 'tool-input-available');
      expect(partial).toBeDefined();
      if (partial?.type === 'tool-input-available') {
        const input = partial.input as Record<string, unknown>;
        expect(input._partial).toBe(true);
        expect(input.path).toBe('/foo.ts');
      }

      const chunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-broken',
                name: 'Write',
                input: { path: '/foo.ts', content: 'truncated-finished' },
              },
            ],
          },
        }),
      );

      const toolInput = chunks.find((c) => c.type === 'tool-input-available');
      expect(toolInput).toBeDefined();
      if (toolInput?.type === 'tool-input-available') {
        expect(toolInput.input).toEqual({ path: '/foo.ts', content: 'truncated-finished' });
      }
    });

    it('repairs malformed nested tool stream JSON with composite toolCallId (subagent tools)', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          parent_tool_use_id: 'task-parent',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'nested-read', name: 'Read' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          parent_tool_use_id: 'task-parent',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"path":"/x' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          parent_tool_use_id: 'task-parent',
          event: { type: 'content_block_stop' },
        }),
      );

      const repairChunks = collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-parent',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'nested-read',
                name: 'Read',
                input: { path: '/x.ts' },
              },
            ],
          },
        }),
      );

      const toolInput = repairChunks.find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'task-parent:nested-read',
      );
      expect(toolInput).toBeDefined();
      if (toolInput?.type === 'tool-input-available') {
        expect(toolInput.input).toEqual({ path: '/x.ts' });
      }
    });

    it('emits partial salvage when stream JSON is truncated before assistant repair', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-broken', name: 'Write' },
          },
        }),
      );
      const stopChunks = collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"path":"/foo.ts","content":"trun' },
          },
        }),
      );
      const stop = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      const toolInput = [...stopChunks, ...stop].find((c) => c.type === 'tool-input-available');
      expect(toolInput).toBeDefined();
      if (toolInput?.type === 'tool-input-available') {
        expect(toolInput.toolCallId).toBe('tool-broken');
        const input = toolInput.input as Record<string, unknown>;
        expect(input.path).toBe('/foo.ts');
        expect(input._partial).toBe(true);
        expect(input._raw).toBe('{"path":"/foo.ts","content":"trun');
      }

      // Result message should not emit another tool-input-available for the same id.
      const resultChunks = collect(
        transform({
          type: 'result',
          usage: { input_tokens: 100, output_tokens: 50 },
          session_id: 'sess-parse-fallback',
        }),
      );
      const extra = resultChunks.find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'tool-broken',
      );
      expect(extra).toBeUndefined();
    });

    it('emits two partial salvages when two stream tools have malformed JSON', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      const allChunks: UIMessageChunk[] = [];

      allChunks.push(
        ...collect(
          transform({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: { type: 'tool_use', id: 'tool-a', name: 'Read' },
            },
          }),
        ),
      );
      allChunks.push(
        ...collect(
          transform({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'input_json_delta', partial_json: '{"path":"/a.json","x":"' },
            },
          }),
        ),
      );
      allChunks.push(
        ...collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } })),
      );

      allChunks.push(
        ...collect(
          transform({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: { type: 'tool_use', id: 'tool-b', name: 'Grep' },
            },
          }),
        ),
      );
      allChunks.push(
        ...collect(
          transform({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'input_json_delta', partial_json: '{"pattern":"z","' },
            },
          }),
        ),
      );
      allChunks.push(
        ...collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } })),
      );

      const partials = allChunks.filter(
        (c): c is Extract<typeof c, { type: 'tool-input-available' }> =>
          c.type === 'tool-input-available' &&
          typeof c.input === 'object' &&
          c.input !== null &&
          (c.input as { _partial?: boolean })._partial === true,
      );
      expect(partials).toHaveLength(2);
      const ids = partials.map((c) => c.toolCallId).sort();
      expect(ids).toEqual(['tool-a', 'tool-b']);
      const byId = Object.fromEntries(partials.map((c) => [c.toolCallId, c]));
      expect((byId['tool-a']?.input as Record<string, unknown>).path).toBe('/a.json');
      expect((byId['tool-b']?.input as Record<string, unknown>).pattern).toBe('z');
    });

    it('repairs two malformed stream tools when assistant emits two tool_use blocks', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 't1', name: 'Read' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"p":' },
          },
        }),
      );
      collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 't2', name: 'Glob' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"g":' },
          },
        }),
      );
      collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } }));

      const chunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/one.ts' } },
              { type: 'tool_use', id: 't2', name: 'Glob', input: { pattern: '*.ts' } },
            ],
          },
        }),
      );

      const available = chunks.filter((c) => c.type === 'tool-input-available');
      expect(available).toHaveLength(2);
      const t1 = available.find((c) => c.toolCallId === 't1');
      const t2 = available.find((c) => c.toolCallId === 't2');
      expect(t1?.type).toBe('tool-input-available');
      expect(t2?.type).toBe('tool-input-available');
      if (t1?.type === 'tool-input-available') expect(t1.input).toEqual({ path: '/one.ts' });
      if (t2?.type === 'tool-input-available') expect(t2.input).toEqual({ pattern: '*.ts' });
    });

    it('repairs one tool via assistant while the other keeps its partial salvage', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'fixed', name: 'Read' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"path":"/bad' },
          },
        }),
      );
      const fixedStop = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'still-broken', name: 'Write' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"file":"/w' },
          },
        }),
      );
      const brokenStop = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      // Both tools received an immediate partial salvage.
      const firstPartial = fixedStop.find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'fixed',
      );
      const secondPartial = brokenStop.find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'still-broken',
      );
      expect(firstPartial).toBeDefined();
      expect(secondPartial).toBeDefined();

      const repairChunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'fixed',
                name: 'Read',
                input: { path: '/ok.ts' },
              },
            ],
          },
        }),
      );

      const repaired = repairChunks.find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'fixed',
      );
      expect(repaired?.type).toBe('tool-input-available');
      if (repaired?.type === 'tool-input-available') {
        expect(repaired.input).toEqual({ path: '/ok.ts' });
      }

      // Result should not re-emit for the unrepaired tool — its partial salvage stands.
      const resultChunks = collect(
        transform({
          type: 'result',
          usage: { input_tokens: 20, output_tokens: 10 },
          session_id: 'sess-partial-fallback',
        }),
      );
      const extras = resultChunks.filter(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'still-broken',
      );
      expect(extras).toHaveLength(0);
    });

    it('produces empty object when no tool input was accumulated', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-empty', name: 'Read' },
          },
        }),
      );
      const chunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      const toolInput = chunks.find((c) => c.type === 'tool-input-available');
      expect(toolInput).toBeDefined();
      if (toolInput?.type === 'tool-input-available') {
        expect(toolInput.input).toEqual({});
      }
    });
  });

  describe('partial tool input bounds', () => {
    /**
     * Stream `partial_json` deltas of `chunkSize` bytes until `totalSize` is reached,
     * never sending `content_block_stop` so the accumulator stays in flight.
     */
    function streamUnclosedPartialJson(
      transform: (msg: unknown) => Generator<UIMessageChunk>,
      toolId: string,
      toolName: string,
      totalSize: number,
      chunkSize = 64 * 1024,
    ): UIMessageChunk[] {
      const all: UIMessageChunk[] = [];
      all.push(...collect(transform({ type: 'system', subtype: 'init' })));
      all.push(
        ...collect(
          transform({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: { type: 'tool_use', id: toolId, name: toolName },
            },
          }),
        ),
      );
      // Open with a key so salvage has something to extract for diagnostics.
      all.push(
        ...collect(
          transform({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x","content":"' },
            },
          }),
        ),
      );
      let written = 0;
      while (written < totalSize) {
        const piece = 'a'.repeat(Math.min(chunkSize, totalSize - written));
        all.push(
          ...collect(
            transform({
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'input_json_delta', partial_json: piece },
              },
            }),
          ),
        );
        written += piece.length;
      }
      return all;
    }

    it('caps `accumulatedToolInput` at MAX_PARTIAL_TOOL_INPUT_BYTES (~2 MiB)', () => {
      const transform = createTransformer();
      // Stream 3 MiB of unclosed partial JSON
      streamUnclosedPartialJson(transform, 'tool-runaway', 'Edit', 3 * 1024 * 1024);

      // Force salvage by emitting content_block_stop
      const stopChunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );
      const partial = stopChunks.find((c) => c.type === 'tool-input-available');
      expect(partial).toBeDefined();
      if (partial?.type === 'tool-input-available') {
        const input = partial.input as Record<string, unknown>;
        expect(input._partial).toBe(true);
        // We exceeded MAX_SALVAGE_RAW_BYTES (64 KiB), so salvage path takes the
        // truncated branch and the cap shows up via _rawLength.
        expect(input._rawTruncated).toBe(true);
        // Cap is 2 MiB; accumulator must not exceed it (raw length === accumulator length).
        expect(typeof input._rawLength).toBe('number');
        expect(input._rawLength as number).toBeLessThanOrEqual(2 * 1024 * 1024);
      }
    });

    it('emits truncated _rawHead/_rawTail when raw input exceeds 64 KiB', () => {
      const transform = createTransformer();
      // 100 KiB — over MAX_SALVAGE_RAW_BYTES (64 KiB) but under cap.
      streamUnclosedPartialJson(transform, 'tool-medium', 'Write', 100 * 1024);

      const stopChunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );
      const partial = stopChunks.find((c) => c.type === 'tool-input-available');
      expect(partial).toBeDefined();
      if (partial?.type === 'tool-input-available') {
        const input = partial.input as Record<string, unknown>;
        expect(input._rawTruncated).toBe(true);
        expect(typeof input._rawHead).toBe('string');
        expect(typeof input._rawTail).toBe('string');
        // Head + tail combined must not exceed the salvage budget.
        expect(
          (input._rawHead as string).length + (input._rawTail as string).length,
        ).toBeLessThanOrEqual(64 * 1024);
        // We never echo the full raw buffer back when truncated.
        expect(input._raw).toBeUndefined();
      }
    });

    it('keeps unbounded `_raw` for small inputs (≤ 64 KiB) so existing salvage works', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-small', name: 'Bash' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la' }, // unclosed
          },
        }),
      );
      const stopChunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );
      const partial = stopChunks.find((c) => c.type === 'tool-input-available');
      expect(partial).toBeDefined();
      if (partial?.type === 'tool-input-available') {
        const input = partial.input as Record<string, unknown>;
        expect(input._partial).toBe(true);
        expect(input._raw).toBe('{"command":"ls -la');
        expect(input._rawTruncated).toBeUndefined();
      }
    });
  });

  describe('result message modelUsage and sdkMessageUuid', () => {
    it('maps modelUsage from result message to metadata', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'result',
          usage: { input_tokens: 100, output_tokens: 50 },
          session_id: 'sess-usage',
          total_cost_usd: 0.05,
          modelUsage: {
            'claude-4': {
              inputTokens: 80,
              outputTokens: 40,
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 5,
              costUSD: 0.03,
            },
          },
        }),
      );

      const metadata = chunks.find((c) => c.type === 'message-metadata');
      expect(metadata).toBeDefined();
      if (metadata?.type === 'message-metadata') {
        expect(metadata.messageMetadata.modelUsage).toBeDefined();
        expect(metadata.messageMetadata.modelUsage?.['claude-4']).toEqual({
          inputTokens: 80,
          outputTokens: 40,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          costUSD: 0.03,
        });
      }
    });

    it('omits modelUsage when not present in result', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'result',
          usage: { input_tokens: 50, output_tokens: 25 },
          session_id: 'sess-no-usage',
        }),
      );

      const metadata = chunks.find((c) => c.type === 'message-metadata');
      if (metadata?.type === 'message-metadata') {
        expect(metadata.messageMetadata.modelUsage).toBeUndefined();
      }
    });

    it('always emits sdkMessageUuid from result messages', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'result',
          uuid: 'msg-uuid-123',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'sess-uuid',
        }),
      );

      const meta = chunks.find((c) => c.type === 'message-metadata');
      if (meta?.type === 'message-metadata') {
        expect(meta.messageMetadata.sdkMessageUuid).toBe('msg-uuid-123');
      }
    });
  });

  describe('dedupe regressions', () => {
    it('does not replay assistant tool_use when already streamed with composite tool id', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      // Streamed tool call under a parent tool context.
      collect(
        transform({
          type: 'stream_event',
          parent_tool_use_id: 'parent-1',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'child-1', name: 'Read' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
        }),
      );
      collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } }));

      // Final assistant message replays the same raw tool id.
      const chunks = collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'parent-1',
          message: {
            content: [{ type: 'tool_use', id: 'child-1', name: 'Read', input: {} }],
          },
        }),
      );

      const replayed = chunks.filter(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'parent-1:child-1',
      );
      expect(replayed).toHaveLength(0);
    });

    it('does not emit duplicate empty thinking chunk when only final thinking block exists', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      // Some providers may emit thinking start/stop without deltas, then send
      // complete thinking text in final assistant content.
      collect(
        transform({
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'thinking' } },
        }),
      );
      collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } }));

      const chunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [{ type: 'thinking', thinking: 'The user wants a briefing document.' }],
          },
        }),
      );

      const thinkingChunks = chunks.filter(
        (c) => c.type === 'tool-input-available' && c.toolName === 'Thinking',
      );
      expect(thinkingChunks).toHaveLength(1);
      if (thinkingChunks[0]?.type === 'tool-input-available') {
        expect(thinkingChunks[0].input).toEqual({ text: 'The user wants a briefing document.' });
        expect(thinkingChunks[0].providerExecuted).toBe(true);
      }
    });

    it('emits exactly one thinking card for out-of-order stream (delta -> assistant -> stop)', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      collect(transform({ type: 'stream_event', event: { type: 'message_start' } }));

      const streamedChunks = collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'partial thinking...' },
          },
        }),
      );

      // Assistant final content arrives before thinking stop.
      const assistantChunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [{ type: 'thinking', thinking: 'final thinking snapshot' }],
          },
        }),
      );

      // Later thinking stop closes the streamed block and emits the final card once.
      const closeChunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      const allThinkingInputs = [...streamedChunks, ...assistantChunks, ...closeChunks].filter(
        (c): c is Extract<typeof c, { type: 'tool-input-available' }> =>
          c.type === 'tool-input-available' && c.toolName === 'Thinking',
      );

      // Streaming thinking emits tool-input-available on each delta; complete() emits again
      // (same toolCallId — UI upserts to one card). Regression guard: assistant replay must
      // not add a second thinking id (previously: stream close + assistant replay = two cards).
      const thinkingIds = new Set(allThinkingInputs.map((c) => c.toolCallId));
      expect(thinkingIds.size).toBe(1);
      expect([...thinkingIds][0]?.startsWith('thinking-')).toBe(true);
      expect(allThinkingInputs.length).toBe(2);
      expect(allThinkingInputs[0]?.input).toEqual({ text: 'partial thinking...' });
      expect(allThinkingInputs[1]?.input).toEqual({ text: 'partial thinking...' });
      expect(allThinkingInputs.every((c) => c.providerExecuted === true)).toBe(true);
    });

    it('allows a later turn to emit final-only thinking after earlier streamed thinking turn', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      // Turn 1: streamed thinking path (sets thinking-streamed sentinel).
      collect(transform({ type: 'stream_event', event: { type: 'message_start' } }));
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'first turn streamed thinking' },
          },
        }),
      );
      collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } }));

      // Turn 2: no deltas, only assistant final thinking content.
      collect(transform({ type: 'stream_event', event: { type: 'message_start' } }));
      const secondTurnChunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [{ type: 'thinking', thinking: 'second turn final-only thinking' }],
          },
        }),
      );

      const secondTurnThinkingInputs = secondTurnChunks.filter(
        (c): c is Extract<typeof c, { type: 'tool-input-available' }> =>
          c.type === 'tool-input-available' && c.toolName === 'Thinking',
      );
      expect(secondTurnThinkingInputs).toHaveLength(1);
      expect(secondTurnThinkingInputs[0].toolCallId.startsWith('text-')).toBe(true);
    });
  });

  describe('subagent Task tool salvage and parent tracking', () => {
    it('salvages subagent_type and description when Task input JSON is truncated', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const startChunks = collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'task-1', name: 'Task' },
          },
        }),
      );
      const deltaChunks = collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: {
              type: 'input_json_delta',
              partial_json:
                '{"description": "Explore frink app glass theme", "subagent_type": "Explore", "prompt": ',
            },
          },
        }),
      );
      const stopChunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      const toolInput = [...startChunks, ...deltaChunks, ...stopChunks].find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'task-1',
      );
      expect(toolInput).toBeDefined();
      if (toolInput?.type === 'tool-input-available') {
        const input = toolInput.input as Record<string, unknown>;
        expect(input.subagent_type).toBe('Explore');
        expect(input.description).toBe('Explore frink app glass theme');
        expect(input._partial).toBe(true);
        expect(toolInput.toolName).toBe('Task');
      }
    });

    it('emits partial with no salvaged fields when JSON has no complete key-value pairs', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'task-bare', name: 'Task' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"description": ' },
          },
        }),
      );
      const stopChunks = collect(
        transform({ type: 'stream_event', event: { type: 'content_block_stop' } }),
      );

      const toolInput = stopChunks.find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'task-bare',
      );
      expect(toolInput).toBeDefined();
      if (toolInput?.type === 'tool-input-available') {
        const input = toolInput.input as Record<string, unknown>;
        expect(input._partial).toBe(true);
        expect(typeof input._raw).toBe('string');
        expect(input.description).toBeUndefined();
      }
    });

    it('assistant-message tool_use supersedes a partial salvage emission', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'task-2', name: 'Task' },
          },
        }),
      );
      collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: {
              type: 'input_json_delta',
              partial_json: '{"description": "x", "subagent_type": "Y", "prompt": ',
            },
          },
        }),
      );
      collect(transform({ type: 'stream_event', event: { type: 'content_block_stop' } }));

      const repairChunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'task-2',
                name: 'Task',
                input: { description: 'x', subagent_type: 'Y', prompt: 'full prompt here' },
              },
            ],
          },
        }),
      );

      const repaired = repairChunks.find(
        (c) => c.type === 'tool-input-available' && c.toolCallId === 'task-2',
      );
      expect(repaired).toBeDefined();
      if (repaired?.type === 'tool-input-available') {
        expect(repaired.input).toEqual({
          description: 'x',
          subagent_type: 'Y',
          prompt: 'full prompt here',
        });
      }
    });

    it('does not prefix root tool_use with a stale parent after a subagent completes', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      // Root emits first Task tool (no parent_tool_use_id on this assistant message).
      collect(
        transform({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'task-A',
                name: 'Task',
                input: { description: 'a', subagent_type: 'Explore', prompt: 'p' },
              },
            ],
          },
        }),
      );

      // Subagent produces a nested Read. Child message carries parent_tool_use_id.
      collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-A',
          message: {
            content: [{ type: 'tool_use', id: 'child-1', name: 'Read', input: { path: '/a' } }],
          },
        }),
      );

      // Root resumes and emits a SECOND Task tool — no parent_tool_use_id on this msg.
      // Without the reset fix, currentParentToolUseId would still be 'task-A' and
      // the second Task would become 'task-A:task-B'.
      const rootChunks = collect(
        transform({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'task-B',
                name: 'Task',
                input: { description: 'b', subagent_type: 'Explore', prompt: 'p2' },
              },
            ],
          },
        }),
      );

      const rootTask = rootChunks.find(
        (c) =>
          c.type === 'tool-input-available' &&
          c.toolName === 'Task' &&
          typeof c.toolCallId === 'string' &&
          c.toolCallId.includes('task-B'),
      );
      expect(rootTask).toBeDefined();
      if (rootTask?.type === 'tool-input-available') {
        expect(rootTask.toolCallId).toBe('task-B');
      }
    });
  });

  describe('subagent output attribution', () => {
    /** Prime the transformer past `start` and open a root text run mid-sentence. */
    function transformerSpeakingRootText() {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      const opening = collect(
        transform({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Four' } },
        }),
      );
      return { transform, opening };
    }

    it('keeps the root paragraph whole when a subagent fires a tool mid-sentence', () => {
      const { transform, opening } = transformerSpeakingRootText();

      const subagentChunks = collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-a',
          message: {
            content: [{ type: 'tool_use', id: 'child-1', name: 'Bash', input: { command: 'ls' } }],
          },
        }),
      );
      expect(subagentChunks.some((c) => c.type === 'text-end')).toBe(false);

      const resumed = collect(
        transform({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' agents running' },
          },
        }),
      );

      const all = [...opening, ...subagentChunks, ...resumed];
      const parts = partsStateFromChunks(all).parts.filter((p) => p.type === 'text');
      expect(parts).toHaveLength(1);
      expect(parts[0].text).toBe('Four agents running');
    });

    it('never lets STREAMED subagent text touch the root text channel', () => {
      // Streamed subagent text used to mint a root text run that the subagent guard then refused to
      // close, so it flushed onto the root's own timeline — duplicating the nested part the
      // consolidating assistant message emits for the same prose.
      const { transform, opening } = transformerSpeakingRootText();
      const streamed = [
        ...collect(
          transform({
            type: 'stream_event',
            parent_tool_use_id: 'task-a',
            event: { type: 'content_block_start', content_block: { type: 'text' } },
          }),
        ),
        ...collect(
          transform({
            type: 'stream_event',
            parent_tool_use_id: 'task-a',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Exploring repo structure.' },
            },
          }),
        ),
        ...collect(
          transform({
            type: 'stream_event',
            parent_tool_use_id: 'task-a',
            event: { type: 'content_block_stop' },
          }),
        ),
        ...collect(
          transform({
            type: 'assistant',
            parent_tool_use_id: 'task-a',
            message: { content: [{ type: 'text', text: 'Exploring repo structure.' }] },
          }),
        ),
      ];
      const resumed = collect(
        transform({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Done.' } },
        }),
      );

      const parts = partsStateFromChunks([...opening, ...streamed, ...resumed]).parts;
      expect(parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual(['Four Done.']);
      expect(parts.filter((p) => p.type === 'tool-SubagentText')).toHaveLength(1);
    });

    it('never lets STREAMED subagent thinking land on the root timeline', () => {
      // The emitter mints a parentless id, and its shared sawThinkingDelta flag would then suppress
      // the composite-id thought the assistant path emits — so the thought must nest, not escape.
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      const streamed = collect(
        transform({
          type: 'stream_event',
          parent_tool_use_id: 'task-a',
          event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } },
        }),
      );
      expect(streamed.filter((c) => c.type !== 'start' && c.type !== 'start-step')).toEqual([]);

      const consolidated = collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-a',
          message: { content: [{ type: 'thinking', thinking: 'hm' }] },
        }),
      );
      const thought = consolidated.find(
        (c) => c.type === 'tool-input-available' && c.toolName === 'Thinking',
      );
      expect(thought).toBeDefined();
      if (thought?.type === 'tool-input-available') {
        expect(thought.toolCallId.startsWith('task-a:')).toBe(true);
      }
    });

    it('still closes the root paragraph at turn end after a subagent spoke last', () => {
      // The subagent guard skips endTextBlock; the turn-end result must still close the run, or the
      // root's reply never gets a text-end and loses its final-response marker.
      const { transform, opening } = transformerSpeakingRootText();
      const subagent = collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-a',
          message: { content: [{ type: 'text', text: 'subagent narration' }] },
        }),
      );
      const ending = collect(transform({ type: 'result', subtype: 'success' }));

      expect(ending.some((c) => c.type === 'text-end')).toBe(true);
      const parts = partsStateFromChunks([...opening, ...subagent, ...ending]).parts;
      expect(parts.filter((p) => p.type === 'text')).toHaveLength(1);
    });

    it('lets the ROOT’s own tool split the paragraph — only nested parts are transparent', () => {
      const { transform, opening } = transformerSpeakingRootText();
      const rootTool = collect(
        transform({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'root-1', name: 'Bash', input: { command: 'ls' } }],
          },
        }),
      );
      const resumed = collect(
        transform({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'after' } },
        }),
      );

      const parts = partsStateFromChunks([...opening, ...rootTool, ...resumed]).parts;
      expect(parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual(['Four', 'after']);
    });

    it('never prefixes a ROOT tool result, even after a subagent ran earlier in the turn', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-a',
          message: { content: [{ type: 'tool_use', id: 'child-1', name: 'Bash', input: {} }] },
        }),
      );

      const chunks = collect(
        transform({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'root-1', content: 'ok' }] },
        }),
      );

      const result = chunks.find((c) => c.type === 'tool-output-available');
      expect(result).toBeDefined();
      if (result?.type === 'tool-output-available') {
        expect(result.toolCallId).toBe('root-1');
      }
    });

    it('gives a subagent thinking block a composite toolCallId', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-a',
          message: { content: [{ type: 'thinking', thinking: 'weighing options' }] },
        }),
      );

      const thought = chunks.find(
        (c) => c.type === 'tool-input-available' && c.toolName === 'Thinking',
      );
      expect(thought).toBeDefined();
      if (thought?.type === 'tool-input-available') {
        expect(thought.toolCallId.startsWith('task-a:')).toBe(true);
      }
    });

    it('emits subagent prose as a settled SubagentText part, never as text chunks', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-a',
          message: { content: [{ type: 'text', text: 'I have enough to write the overview.' }] },
        }),
      );

      expect(chunks.some((c) => c.type.startsWith('text-'))).toBe(false);
      const prose = chunks.find(
        (c) => c.type === 'tool-input-available' && c.toolName === 'SubagentText',
      );
      expect(prose).toBeDefined();
      if (prose?.type === 'tool-input-available') {
        expect(prose.toolCallId.startsWith('task-a:')).toBe(true);
        expect(prose.input).toEqual({ text: 'I have enough to write the overview.' });
        expect(
          chunks.some(
            (c) => c.type === 'tool-output-available' && c.toolCallId === prose.toolCallId,
          ),
        ).toBe(true);
      }
    });

    it('leaves root prose on the text channel once the subagent is done', () => {
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));
      collect(
        transform({
          type: 'assistant',
          parent_tool_use_id: 'task-a',
          message: { content: [{ type: 'text', text: 'subagent says hi' }] },
        }),
      );

      const rootChunks = collect(
        transform({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
      );

      expect(rootChunks.some((c) => c.type === 'text-delta' && c.delta === 'Done.')).toBe(true);
      expect(rootChunks.some((c) => c.type === 'tool-input-available')).toBe(false);
    });

    it('keys a sub-subagent identically whether or not the id map is warm', () => {
      // A wake burst rebuilds the transformer with an empty map. The id a call gets must not depend
      // on that, or its result lands under a different key and matches no card.
      const grandchildId = (primeTheMap: boolean) => {
        const transform = createTransformer();
        collect(transform({ type: 'system', subtype: 'init' }));
        if (primeTheMap) {
          collect(
            transform({
              type: 'assistant',
              parent_tool_use_id: 'a',
              message: { content: [{ type: 'tool_use', id: 'b', name: 'Task', input: {} }] },
            }),
          );
        }
        const chunks = collect(
          transform({
            type: 'assistant',
            parent_tool_use_id: 'b',
            message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }] },
          }),
        );
        const call = chunks.find((c) => c.type === 'tool-input-available' && c.toolName === 'Bash');
        return call?.type === 'tool-input-available' ? call.toolCallId : null;
      };

      expect(grandchildId(true)).toBe('b:c');
      expect(grandchildId(false)).toBe('b:c');
    });

    it('rebuilds the composite id for a tool result whose call predates this transformer', () => {
      // A wake burst replaces the transformer, so the id map is empty when the result lands.
      const transform = createTransformer();
      collect(transform({ type: 'system', subtype: 'init' }));

      const chunks = collect(
        transform({
          type: 'user',
          parent_tool_use_id: 'task-a',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'child-1', content: 'done' }],
          },
        }),
      );

      const result = chunks.find((c) => c.type === 'tool-output-available');
      expect(result).toBeDefined();
      if (result?.type === 'tool-output-available') {
        expect(result.toolCallId).toBe('task-a:child-1');
      }
    });
  });
});
