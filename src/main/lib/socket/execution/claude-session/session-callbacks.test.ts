import { describe, expect, it, vi } from 'vitest';
import { compactionSummaryJoinFor } from '../../../claude/compaction';
import type { UIMessageChunk } from '../../../claude/types';
import type { ClaudeSession } from '../../claude-session-registry';
import { buildPartsFromChunks } from '../../claude-turn-context';
import { buildClaudeSessionCallbacks, type ClaudeSessionScope } from './session-callbacks';

const warn = vi.hoisted(() => vi.fn());
vi.mock('electron-log', () => ({ default: { warn, info: vi.fn(), error: vi.fn() } }));

const scope = {
  chatId: 'chat-1',
  subChatId: 'sub-1',
  project: null,
  projectPath: '/tmp/p',
  permissionProjectPath: '/tmp/p',
  agents: {},
  validateToolPermission: vi.fn(),
  abortSources: new Map(),
} as unknown as ClaudeSessionScope;

/** The slice of a live turn the PostCompact hook reads: its collected chunks and chunk sink. */
function fakeTurn() {
  let index = 0;
  return {
    msgId: 'assistant-1',
    lastCollectedChunks: [] as UIMessageChunk[],
    nextMessageIndex: () => index++,
    execution: { sendChunk: vi.fn() },
  };
}

let sessionCounter = 0;

function setup(turn: ReturnType<typeof fakeTurn> | null) {
  const ref = { current: { currentTurn: turn } as unknown as ClaudeSession };
  const callbacks = buildClaudeSessionCallbacks(scope, ref);
  const hook = callbacks.hooks.PostCompact[0].hooks[0] as (input: unknown) => Promise<unknown>;
  const sessionId = `hook-session-${++sessionCounter}`;
  return {
    join: compactionSummaryJoinFor(sessionId),
    postCompact: (input: Record<string, unknown>) => hook({ session_id: sessionId, ...input }),
  };
}

const settled = { state: 'output-available' as const, trigger: 'manual' as const };

describe('PostCompact hook', () => {
  it('re-emits the settled card with its summary when the boundary landed first', async () => {
    const turn = fakeTurn();
    const { join, postCompact } = setup(turn);
    const boundary: UIMessageChunk = {
      type: 'data-compact',
      id: 'compact-1',
      data: join.onSettled('compact-1', settled),
    };
    turn.lastCollectedChunks.push(boundary);

    await postCompact({ hook_event_name: 'PostCompact', compact_summary: 'the gist' });

    const reemitted = {
      type: 'data-compact',
      id: 'compact-1',
      data: { ...settled, summary: 'the gist' },
    };
    expect(turn.execution.sendChunk).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', subChatId: 'sub-1', chunk: reemitted }),
    );
    // The persisted parts fold the re-emission onto the one existing card, not a second one.
    const compactParts = buildPartsFromChunks(turn.lastCollectedChunks).filter(
      (part) => part.type === 'data-compact',
    );
    expect(compactParts).toEqual([expect.objectContaining({ data: reemitted.data })]);
  });

  it('emits nothing when the summary arrives first, and the boundary then carries it', async () => {
    const turn = fakeTurn();
    const { join, postCompact } = setup(turn);

    await postCompact({ hook_event_name: 'PostCompact', compact_summary: 'early' });

    expect(turn.execution.sendChunk).not.toHaveBeenCalled();
    expect(join.onSettled('compact-1', settled)).toEqual({
      ...settled,
      summary: 'early',
    });
  });

  it('logs and drops the re-emission when no turn is attached', async () => {
    const { join, postCompact } = setup(null);
    join.onSettled('compact-1', settled);

    await expect(
      postCompact({ hook_event_name: 'PostCompact', compact_summary: 'orphan' }),
    ).resolves.toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it.each([[''], ['   '], [undefined], [42]])(
    'ignores a missing or blank summary (%s)',
    async (summary) => {
      const turn = fakeTurn();
      const { join, postCompact } = setup(turn);
      join.onSettled('compact-1', settled);

      await postCompact({ hook_event_name: 'PostCompact', compact_summary: summary });

      expect(turn.execution.sendChunk).not.toHaveBeenCalled();
      // The card is still waiting, so a real summary can complete it.
      expect(join.onSummary('real')).toMatchObject({ id: 'compact-1' });
    },
  );

  it('ignores a hook input that carries no session id', async () => {
    const turn = fakeTurn();
    const { join, postCompact } = setup(turn);
    join.onSettled('compact-1', settled);

    await postCompact({ session_id: undefined, compact_summary: 'unroutable' });

    expect(turn.execution.sendChunk).not.toHaveBeenCalled();
    expect(join.onSummary('real')).toMatchObject({ id: 'compact-1' });
  });
});
