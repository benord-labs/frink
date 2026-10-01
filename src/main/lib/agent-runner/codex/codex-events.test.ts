/**
 * Pure mapping unit tests: codex notification -> UIMessageChunk, and approval
 * request/decision mapping. No process, no I/O.
 */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_REQUEST_METHODS,
  COMMAND_APPROVAL_METHOD,
  declineApprovalResponse,
  extractFileChangeItem,
  FILE_CHANGE_APPROVAL_METHOD,
  mapApprovalRequests,
  mapNotificationToChunks,
  mergeDelta,
} from './codex-events';

describe('mapNotificationToChunks', () => {
  it('maps agentMessage/delta to a text-delta keyed by itemId', () => {
    expect(
      mapNotificationToChunks('item/agentMessage/delta', {
        threadId: 't',
        turnId: 'u',
        itemId: 'i1',
        delta: 'hi',
      }),
    ).toEqual([{ type: 'text-delta', id: 'i1', delta: 'hi' }]);
  });

  it('maps reasoning/textDelta to a reasoning-delta', () => {
    expect(
      mapNotificationToChunks('item/reasoning/textDelta', { itemId: 'r1', delta: 'think' }),
    ).toEqual([{ type: 'reasoning-delta', id: 'r1', delta: 'think' }]);
  });

  it('opens a tool card on item/started for a commandExecution item', () => {
    const chunks = mapNotificationToChunks('item/started', {
      threadId: 't',
      turnId: 'u',
      item: { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/repo' },
    });
    expect(chunks).toEqual([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'Bash' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'Bash',
        input: { command: 'ls -la', cwd: '/repo' },
      },
    ]);
  });

  it('names an mcpToolCall item by server + tool', () => {
    const chunks = mapNotificationToChunks('item/started', {
      item: { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'list', arguments: { a: 1 } },
    });
    expect(chunks[0]).toEqual({
      type: 'tool-input-start',
      toolCallId: 'm1',
      toolName: 'mcp__github__list',
    });
  });

  it('does not open a tool card for a non-tool item (reasoning)', () => {
    expect(
      mapNotificationToChunks('item/started', { item: { type: 'reasoning', id: 'x' } }),
    ).toEqual([]);
  });

  it('closes a commandExecution tool card with aggregated output on item/completed', () => {
    expect(
      mapNotificationToChunks('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'c1',
          status: 'completed',
          aggregatedOutput: 'done',
          exitCode: 0,
        },
      }).at(-1),
    ).toEqual({
      type: 'tool-output-available',
      toolCallId: 'c1',
      output: { output: 'done', exitCode: 0 },
    });
  });

  it('closes a declined commandExecution as a blocked command card', () => {
    expect(
      mapNotificationToChunks('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'c1',
          command: 'touch /tmp/blocked',
          status: 'declined',
          aggregatedOutput: 'command denied by Frink permissions',
          exitCode: -1,
        },
      }).at(-1),
    ).toEqual({
      type: 'tool-output-error',
      toolCallId: 'c1',
      errorText: 'command denied by Frink permissions',
    });
  });

  it('closes the text block on an agentMessage item/completed', () => {
    expect(
      mapNotificationToChunks('item/completed', {
        item: { type: 'agentMessage', id: 'i1', text: 'x' },
      }),
    ).toEqual([{ type: 'text-end', id: 'i1' }]);
  });

  it('maps thread/tokenUsage/updated to token totals and context occupancy', () => {
    expect(
      mapNotificationToChunks('thread/tokenUsage/updated', {
        threadId: 't',
        turnId: 'u',
        tokenUsage: {
          total: { totalTokens: 30, inputTokens: 10, outputTokens: 20 },
          last: { totalTokens: 5 },
          modelContextWindow: 272_000,
        },
      }),
    ).toEqual([
      {
        type: 'message-metadata',
        messageMetadata: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          // Occupancy is the latest call, not the thread's running total.
          contextTokens: 5,
          contextWindow: 272_000,
        },
      },
    ]);
  });

  it('maps a successful turn/completed to finish', () => {
    expect(
      mapNotificationToChunks('turn/completed', { threadId: 't', turn: { status: 'completed' } }),
    ).toEqual([{ type: 'finish' }]);
    // No turn object (defensive) still finishes.
    expect(mapNotificationToChunks('turn/completed', { threadId: 't' })).toEqual([
      { type: 'finish' },
    ]);
  });

  it('maps a failed/interrupted turn/completed to an error chunk from turn.error', () => {
    expect(
      mapNotificationToChunks('turn/completed', {
        threadId: 't',
        turn: { status: 'failed', error: { message: 'model exploded' } },
      }),
    ).toEqual([{ type: 'error', errorText: 'model exploded' }]);
    expect(
      mapNotificationToChunks('turn/completed', { threadId: 't', turn: { status: 'interrupted' } }),
    ).toEqual([{ type: 'error', errorText: 'Codex turn interrupted' }]);
  });

  it('maps an error notification to an error chunk read from error.message', () => {
    // Wire shape: { error: TurnError{message}, willRetry, threadId, turnId }.
    expect(
      mapNotificationToChunks('error', {
        threadId: 't',
        turnId: 'u',
        error: { message: 'boom' },
        willRetry: false,
      }),
    ).toEqual([{ type: 'error', errorText: 'boom' }]);
  });

  it('tags a usage limit as RATE_LIMIT_SDK from codexErrorInfo, on either wire path', () => {
    const error = { message: 'You’ve hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' };
    const expected = [
      { type: 'error', errorText: error.message, debugInfo: { category: 'RATE_LIMIT_SDK' } },
    ];
    expect(
      mapNotificationToChunks('turn/completed', {
        threadId: 't',
        turn: { status: 'failed', error },
      }),
    ).toEqual(expected);
    expect(mapNotificationToChunks('error', { threadId: 't', error, willRetry: false })).toEqual(
      expected,
    );
  });

  it('returns no chunks for output deltas and unknown methods', () => {
    expect(mapNotificationToChunks('item/commandExecution/outputDelta', { delta: 'x' })).toEqual(
      [],
    );
    expect(mapNotificationToChunks('totally/unknown', {})).toEqual([]);
  });

  it('opens and closes a fileChange tool card as an Edit', () => {
    const started = mapNotificationToChunks('item/started', {
      item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] },
    });
    expect(started).toEqual([
      { type: 'tool-input-start', toolCallId: 'f1', toolName: 'Edit' },
      {
        type: 'tool-input-available',
        toolCallId: 'f1',
        toolName: 'Edit',
        input: { changes: [{ path: 'a.ts' }] },
      },
    ]);
    // A completion re-opens the card before closing it (see the completed-only case below), so the
    // output chunk is the LAST of three rather than the only one.
    expect(
      mapNotificationToChunks('item/completed', {
        item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] },
      }).at(-1),
    ).toEqual({
      type: 'tool-output-available',
      toolCallId: 'f1',
      output: { changes: [{ path: 'a.ts' }] },
    });
  });

  it('closes an mcpToolCall card with the error when the call failed', () => {
    expect(
      mapNotificationToChunks('item/completed', {
        item: { type: 'mcpToolCall', id: 'm1', server: 'gh', tool: 'list', error: 'rate limited' },
      }).at(-1),
    ).toEqual({
      type: 'tool-output-available',
      toolCallId: 'm1',
      output: { error: 'rate limited' },
    });
  });

  it('names a webSearch and a dynamicToolCall item and carries their input', () => {
    expect(
      mapNotificationToChunks('item/started', {
        item: { type: 'webSearch', id: 'w1', query: 'how to frink' },
      }),
    ).toEqual([
      { type: 'tool-input-start', toolCallId: 'w1', toolName: 'WebSearch' },
      {
        type: 'tool-input-available',
        toolCallId: 'w1',
        toolName: 'WebSearch',
        input: { query: 'how to frink' },
      },
    ]);
    expect(
      mapNotificationToChunks('item/started', {
        item: { type: 'dynamicToolCall', id: 'd1', tool: 'render', arguments: { x: 1 } },
      })[0],
    ).toEqual({ type: 'tool-input-start', toolCallId: 'd1', toolName: 'render' });
  });

  it('falls back to a synthetic codex_<type> tool name for an unrecognized tool item', () => {
    // Forward-compat: a new ThreadItem variant must still surface a stable card name.
    expect(
      mapNotificationToChunks('item/started', { item: { type: 'commandExecution', id: 'c1' } })[0],
    ).toMatchObject({ toolName: 'Bash' });
    // An mcpToolCall missing server/tool falls back to the generic mcp__mcp__tool name.
    expect(
      mapNotificationToChunks('item/started', { item: { type: 'mcpToolCall', id: 'm2' } })[0],
    ).toEqual({ type: 'tool-input-start', toolCallId: 'm2', toolName: 'mcp__mcp__tool' });
  });

  it('emits no token metadata when the usage payload has no running total', () => {
    expect(mapNotificationToChunks('thread/tokenUsage/updated', {})).toEqual([]);
    expect(
      mapNotificationToChunks('thread/tokenUsage/updated', { tokenUsage: { last: { x: 1 } } }),
    ).toEqual([]);
  });

  it('finishes (not errors) for an unknown turn status', () => {
    // Only failed/interrupted produce an error chunk; inProgress/completed/etc finish.
    expect(mapNotificationToChunks('turn/completed', { turn: { status: 'inProgress' } })).toEqual([
      { type: 'finish' },
    ]);
  });

  it('opens a card for a completed-only item so it is not dropped downstream', () => {
    // subAgentActivity is emitted upstream ONLY via emit_turn_item_completed — it never sends an
    // item/started. The parts reducer discards an output for a toolCallId it never opened, so a
    // completion must carry the opening chunks itself or codex subagent work renders as nothing.
    const chunks = mapNotificationToChunks('item/completed', {
      completedAtMs: 1_000,
      item: { type: 'subAgentActivity', id: 's1', kind: 'started', agentPath: '.codex/design.md' },
    });
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
    ]);
    expect(chunks[0]).toMatchObject({ toolName: 'SubagentStarted' });
    expect(chunks[1]).toMatchObject({ input: { path: '.codex/design.md' } });
  });

  it('renders newly-mapped job items instead of dropping them', () => {
    // The three variants the "idle conversation" report was actually about.
    const names = ['imageGeneration', 'collabAgentToolCall', 'sleep'].map(
      (type) => mapNotificationToChunks('item/started', { item: { type, id: 'x' } })[0],
    );
    expect(names).toMatchObject([
      { toolName: 'ImageGeneration' },
      { toolName: 'CodexSubagent' },
      { toolName: 'Sleep' },
    ]);
  });

  it('emits no card for lifecycle markers that are not jobs', () => {
    // The denylist's whole job: review-mode and compaction transitions would otherwise render as
    // instantly-complete junk cards on every turn that uses them.
    for (const type of [
      'enteredReviewMode',
      'exitedReviewMode',
      'contextCompaction',
      'imageView',
      'functionCallOutput',
    ]) {
      expect(mapNotificationToChunks('item/started', { item: { type, id: 'l1' } })).toEqual([]);
      expect(mapNotificationToChunks('item/completed', { item: { type, id: 'l1' } })).toEqual([]);
    }
  });

  it('marks a failed image generation as an error with a readable reason', () => {
    // Upstream sends `result: ""` on every failure and fills `failure` only for the image_gen usage
    // limit (null for content policy and the rest), so both arms must still produce a sentence.
    type FailureFixture = { type: string; limitId: string; resetsAt: number | null } | null;
    const failed = (id: string, failure: FailureFixture) =>
      mapNotificationToChunks('item/completed', {
        completedAtMs: 5,
        item: { type: 'imageGeneration', id, status: 'failed', result: '', failure },
      }).at(-1);
    expect(failed('i1', null)).toEqual({
      type: 'tool-output-error',
      toolCallId: 'i1',
      errorText: 'Image generation failed',
    });
    expect(
      failed('i2', { type: 'usageLimitExceeded', limitId: 'image_gen', resetsAt: null }),
    ).toEqual({
      type: 'tool-output-error',
      toolCallId: 'i2',
      errorText: 'Image generation limit reached',
    });
    expect(
      failed('i3', { type: 'usageLimitExceeded', limitId: 'image_gen', resetsAt: 1_700_000_000 }),
    ).toMatchObject({
      type: 'tool-output-error',
      errorText: expect.stringMatching(/^Image generation limit reached, resets \S/),
    });
  });

  it('persists the saved path of a generated image, never the bitmap', () => {
    // `result` is the same PNG as bare base64 (multi-MB); the card reads the file back from disk.
    const chunks = mapNotificationToChunks('item/completed', {
      completedAtMs: 5,
      item: {
        type: 'imageGeneration',
        id: 'i2',
        status: 'completed',
        revisedPrompt: 'a cat',
        savedPath: '/tmp/a.png',
        result: 'iVBORw0KGgo=',
      },
    });
    expect(chunks.at(-1)).toEqual({
      type: 'tool-output-available',
      toolCallId: 'i2',
      output: { path: '/tmp/a.png' },
    });
    expect(chunks[1]).toMatchObject({ type: 'tool-input-available', input: { prompt: 'a cat' } });
  });

  it('reports a failed collab job on the channel the subagent card actually reads', () => {
    // A failure must travel as tool-output-error, which the parts reducer turns into errorText.
    // Signalling it inside the output payload instead left AgentTaskTool — which detects failure
    // only via errorText — rendering a failed subagent job as "Completed Subagent".
    expect(
      mapNotificationToChunks('item/completed', {
        completedAtMs: 5,
        item: {
          type: 'collabAgentToolCall',
          id: 'c1',
          tool: 'wait',
          status: 'failed',
          receiverThreadIds: ['a', 'b'],
        },
      }).at(-1),
    ).toEqual({
      type: 'tool-output-error',
      toolCallId: 'c1',
      errorText: 'Waiting on agents (2) failed',
    });
    // A genuinely completed collab job still closes normally.
    expect(
      mapNotificationToChunks('item/completed', {
        completedAtMs: 5,
        item: { type: 'collabAgentToolCall', id: 'c2', tool: 'wait', status: 'completed' },
      }).at(-1),
    ).toMatchObject({ type: 'tool-output-available' });
    // Only an explicit success reads as success: an unrecognised terminal status must not let the
    // card claim the job worked. Guards the enum growing a value this mapper has not been taught.
    expect(
      mapNotificationToChunks('item/completed', {
        completedAtMs: 5,
        item: { type: 'collabAgentToolCall', id: 'c3', tool: 'spawnAgent', status: 'cancelled' },
      }).at(-1),
    ).toMatchObject({ type: 'tool-output-error', errorText: 'Spawning agent failed' });
  });

  it('threads the wire start timestamp onto the card so the elapsed timer can run', () => {
    expect(
      mapNotificationToChunks('item/started', {
        startedAtMs: 1_700_000_000_000,
        item: {
          type: 'collabAgentToolCall',
          id: 'c9',
          tool: 'wait',
          receiverThreadIds: ['a', 'b'],
        },
      })[1],
    ).toMatchObject({
      input: { startedAt: 1_700_000_000_000, description: 'Waiting on agents (2)' },
    });
  });

  it('omits a non-positive start timestamp instead of stamping the epoch', () => {
    // The card's elapsed timer is `Date.now() - startedAt`. A zero or negative timestamp is not a
    // real instant, and stamping one yields either a silently dead timer or an absurd age (a
    // negative value is truthy, so it survives the card's own guard and renders as ~57000000m).
    for (const startedAtMs of [0, -1, -1_700_000_000_000]) {
      const [, inputChunk] = mapNotificationToChunks('item/started', {
        startedAtMs,
        item: { type: 'collabAgentToolCall', id: 'c1', tool: 'wait' },
      });
      expect((inputChunk as { input: Record<string, unknown> }).input).not.toHaveProperty(
        'startedAt',
      );
    }
  });

  it('omits a start timestamp that a bogus wire duration pushed before the epoch', () => {
    // startedAt on a completion is derived as completedAtMs - durationMs; a nonsense duration must
    // not produce a pre-epoch instant the card would render as an enormous elapsed time.
    const [, inputChunk] = mapNotificationToChunks('item/completed', {
      completedAtMs: 1_700_000_000_000,
      item: {
        type: 'commandExecution',
        id: 'c1',
        command: 'ls',
        durationMs: Number.MAX_SAFE_INTEGER,
      },
    });
    expect((inputChunk as { input: Record<string, unknown> }).input).not.toHaveProperty(
      'startedAt',
    );
  });

  it('omits startedAt entirely when the notification carried no timestamp', () => {
    // Stamping 0 would date the card to 1970 and render a ~56-year elapsed time.
    const [, inputChunk] = mapNotificationToChunks('item/completed', {
      item: { type: 'commandExecution', id: 'c1', command: 'ls' },
    });
    expect(inputChunk).toMatchObject({ type: 'tool-input-available' });
    expect((inputChunk as { input: Record<string, unknown> }).input).not.toHaveProperty(
      'startedAt',
    );
  });

  it('names an unrecognised collab operation rather than leaving the card blank', () => {
    expect(
      mapNotificationToChunks('item/started', {
        item: { type: 'collabAgentToolCall', id: 'c1' },
      })[1],
    ).toMatchObject({ input: { description: 'Collab agent' } });
  });
});

describe('mapApprovalRequests', () => {
  it('maps a command-exec approval to a single Bash tool call', () => {
    expect(
      mapApprovalRequests(COMMAND_APPROVAL_METHOD, {
        threadId: 't',
        turnId: 'u',
        itemId: 'i',
        command: 'rm -rf build',
        cwd: '/repo',
        reason: 'cleanup',
      }),
    ).toEqual([
      { toolName: 'Bash', input: { command: 'rm -rf build', cwd: '/repo' }, reason: 'cleanup' },
    ]);
  });

  it('expands a file-change approval to one Edit per real per-file path', () => {
    // The runner passes the cached fileChange paths; each becomes its own gated Edit.
    expect(
      mapApprovalRequests(
        FILE_CHANGE_APPROVAL_METHOD,
        { itemId: 'i', grantRoot: '/repo', reason: 'patch' },
        [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }],
      ),
    ).toEqual([
      { toolName: 'Edit', input: { file_path: '/repo/a.ts' }, reason: 'patch' },
      { toolName: 'Edit', input: { file_path: '/repo/b.ts' }, reason: 'patch' },
    ]);
  });

  it('falls back to the grant root when no cached changes are available', () => {
    expect(
      mapApprovalRequests(FILE_CHANGE_APPROVAL_METHOD, { itemId: 'i', grantRoot: '/repo/src' }),
    ).toEqual([{ toolName: 'Edit', input: { file_path: '/repo/src' }, reason: undefined }]);
  });

  it('treats empty / pathless changes as no paths and falls back (never an empty list)', () => {
    // An empty list would vacuously accept — these MUST each yield one gated request.
    for (const changes of [[], [{}], [{ path: '' }]]) {
      expect(
        mapApprovalRequests(FILE_CHANGE_APPROVAL_METHOD, { grantRoot: '/repo' }, changes),
      ).toEqual([{ toolName: 'Edit', input: { file_path: '/repo' }, reason: undefined }]);
    }
  });

  it('defaults a command approval with no command to an empty string (still gates)', () => {
    // A malformed/partial request must not crash the gate — empty command, no cwd.
    expect(mapApprovalRequests(COMMAND_APPROVAL_METHOD, {})).toEqual([
      { toolName: 'Bash', input: { command: '', cwd: undefined }, reason: undefined },
    ]);
  });

  it('defaults a file-change with no changes and no grantRoot to one empty-path Edit (gate prompts)', () => {
    // Empty file_path is the documented safe default: the gate prompts rather than
    // silently allowing a write at an unknown root. Still a non-empty list (one request).
    expect(mapApprovalRequests(FILE_CHANGE_APPROVAL_METHOD, {})).toEqual([
      { toolName: 'Edit', input: { file_path: '' }, reason: undefined },
    ]);
  });

  it('treats an unknown approval method as a file-change (safe Edit default)', () => {
    // Defensive: any non-command method falls through to the gated Edit branch.
    expect(mapApprovalRequests('item/unknown/requestApproval', { grantRoot: '/x' })).toEqual([
      { toolName: 'Edit', input: { file_path: '/x' }, reason: undefined },
    ]);
  });
});

describe('extractFileChangeItem', () => {
  it('pulls itemId + changes off a fileChange item/started payload', () => {
    expect(
      extractFileChangeItem({
        item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] },
      }),
    ).toEqual({ itemId: 'f1', changes: [{ path: 'a.ts' }] });
  });

  it('returns an empty changes array when the fileChange item omits changes', () => {
    expect(extractFileChangeItem({ item: { type: 'fileChange', id: 'f2' } })).toEqual({
      itemId: 'f2',
      changes: [],
    });
  });

  it('returns null for a non-fileChange item or a missing item', () => {
    expect(extractFileChangeItem({ item: { type: 'commandExecution', id: 'c1' } })).toBeNull();
    expect(extractFileChangeItem({})).toBeNull();
  });

  it('returns null for a fileChange item with no id (would collide with the cache-miss key)', () => {
    // Caching an id-less item under '' would mis-apply its paths to any approval whose
    // itemId is also absent (→ ''). Refuse to cache it instead.
    expect(
      extractFileChangeItem({ item: { type: 'fileChange', changes: [{ path: 'a.ts' }] } }),
    ).toBeNull();
  });

  it('reads the real FileUpdateChange wire shape (path + kind + diff), feeding correct gating', () => {
    // codex sends full FileUpdateChange objects ({ path, kind, diff }), not bare { path }.
    // Extraction must survive the extra fields, and per-file gating reads only .path.
    // (Gating the Update.movePath rename target is the deferred sc-942 hardening.)
    const extracted = extractFileChangeItem({
      item: {
        type: 'fileChange',
        id: 'f9',
        changes: [
          { path: '/repo/a.ts', kind: { type: 'add' }, diff: '+a' },
          { path: '/repo/b.ts', kind: { type: 'update', movePath: '/repo/c.ts' }, diff: '@@' },
        ],
      },
    });
    expect(extracted?.itemId).toBe('f9');
    expect(
      mapApprovalRequests(FILE_CHANGE_APPROVAL_METHOD, { itemId: 'f9' }, extracted?.changes),
    ).toEqual([
      { toolName: 'Edit', input: { file_path: '/repo/a.ts' }, reason: undefined },
      { toolName: 'Edit', input: { file_path: '/repo/b.ts' }, reason: undefined },
    ]);
  });
});

describe('mergeDelta', () => {
  it('merges two adjacent same-id text deltas into one concatenated chunk', () => {
    expect(
      mergeDelta(
        { type: 'text-delta', id: 'i1', delta: 'Hel' },
        { type: 'text-delta', id: 'i1', delta: 'lo' },
      ),
    ).toEqual({ type: 'text-delta', id: 'i1', delta: 'Hello' });
  });

  it('merges adjacent same-id reasoning deltas', () => {
    expect(
      mergeDelta(
        { type: 'reasoning-delta', id: 'r1', delta: 'a' },
        { type: 'reasoning-delta', id: 'r1', delta: 'b' },
      ),
    ).toEqual({ type: 'reasoning-delta', id: 'r1', delta: 'ab' });
  });

  it('refuses to merge across different itemIds (interleaved streams)', () => {
    expect(
      mergeDelta(
        { type: 'text-delta', id: 'i1', delta: 'a' },
        { type: 'text-delta', id: 'i2', delta: 'b' },
      ),
    ).toBeNull();
  });

  it('refuses to merge across delta kinds (text vs reasoning)', () => {
    expect(
      mergeDelta(
        { type: 'text-delta', id: 'i1', delta: 'a' },
        { type: 'reasoning-delta', id: 'i1', delta: 'b' },
      ),
    ).toBeNull();
  });

  it('refuses to merge when either side is not a streamed delta (text-start / text-end)', () => {
    expect(
      mergeDelta({ type: 'text-start', id: 'i1' }, { type: 'text-delta', id: 'i1', delta: 'a' }),
    ).toBeNull();
    expect(
      mergeDelta({ type: 'text-delta', id: 'i1', delta: 'a' }, { type: 'text-end', id: 'i1' }),
    ).toBeNull();
  });
});

describe('approval request contracts', () => {
  it('registers only request families with the decision response shape', () => {
    expect(APPROVAL_REQUEST_METHODS).toEqual([
      COMMAND_APPROVAL_METHOD,
      FILE_CHANGE_APPROVAL_METHOD,
      'item/permissions/requestApproval',
    ]);
    expect(declineApprovalResponse()).toEqual({ decision: 'decline' });
  });

  it('never opts the turn into strict auto-review', () => {
    expect(declineApprovalResponse()).not.toHaveProperty('strictAutoReview');
  });
});
