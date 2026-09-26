import { describe, expect, it } from 'vitest';
import type { FolderCursor, SidebarChatListItem, SidebarPolledTask } from './utils';
import {
  buildChatReasonMap,
  buildChatTaskStatusMap,
  buildPendingQuestionChatIds,
  bumpChatUpdatedAtInFolderMap,
  extractErrorMessage,
  mergeChatsById,
  normalizeCursor,
  sameSidebarTasks,
} from './utils';

function makeChatItem(
  overrides: Partial<SidebarChatListItem> & Pick<SidebarChatListItem, 'id' | 'updatedAt'>,
): SidebarChatListItem {
  return {
    name: null,
    projectId: null,
    createdAt: new Date('2025-01-01'),
    archivedAt: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    prNumber: null,
    taskId: null,
    batchId: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe('normalizeCursor', () => {
  it('returns null for null input', () => {
    expect(normalizeCursor(null)).toBeNull();
  });

  it('passes through a valid string cursor', () => {
    const cursor: FolderCursor = { updatedAt: '2025-06-01T00:00:00.000Z', id: 'abc-123' };
    expect(normalizeCursor(cursor)).toEqual(cursor);
  });

  it('converts Date updatedAt to ISO string', () => {
    const date = new Date('2025-06-01T12:00:00Z');
    const cursor = { updatedAt: date, id: 'abc-123' } as unknown as FolderCursor;
    expect(normalizeCursor(cursor)).toEqual({
      updatedAt: '2025-06-01T12:00:00.000Z',
      id: 'abc-123',
    });
  });

  it('returns null when updatedAt is neither string nor Date', () => {
    const cursor = { updatedAt: 12345, id: 'abc-123' } as unknown as FolderCursor;
    expect(normalizeCursor(cursor)).toBeNull();
  });

  it('returns null when id is not a string', () => {
    const cursor = { updatedAt: '2025-06-01T00:00:00.000Z', id: 42 } as unknown as FolderCursor;
    expect(normalizeCursor(cursor)).toBeNull();
  });
});

describe('extractErrorMessage', () => {
  it('returns message from Error instance', () => {
    expect(extractErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('returns message from plain object with message property', () => {
    expect(extractErrorMessage({ message: 'oops' })).toBe('oops');
  });

  it('returns null for Error with empty message', () => {
    expect(extractErrorMessage(new Error(''))).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractErrorMessage(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractErrorMessage(undefined)).toBeNull();
  });

  it('returns null for string input', () => {
    expect(extractErrorMessage('raw string')).toBeNull();
  });

  it('returns null for object with non-string message', () => {
    expect(extractErrorMessage({ message: 42 })).toBeNull();
  });

  it('returns null for object with empty string message', () => {
    expect(extractErrorMessage({ message: '' })).toBeNull();
  });
});

describe('mergeChatsById', () => {
  it('returns empty array for empty input', () => {
    expect(mergeChatsById([])).toEqual([]);
  });

  it('deduplicates by id, keeping last occurrence', () => {
    const older = makeChatItem({ id: 'a', updatedAt: new Date('2025-01-01'), name: 'old' });
    const newer = makeChatItem({ id: 'a', updatedAt: new Date('2025-06-01'), name: 'new' });
    const result = mergeChatsById([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('new');
  });

  it('sorts by updatedAt descending', () => {
    const a = makeChatItem({ id: 'a', updatedAt: new Date('2025-01-01') });
    const b = makeChatItem({ id: 'b', updatedAt: new Date('2025-06-01') });
    const c = makeChatItem({ id: 'c', updatedAt: new Date('2025-03-01') });
    const result = mergeChatsById([a, b, c]);
    expect(result.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by id descending', () => {
    const sameTime = new Date('2025-06-01');
    const a = makeChatItem({ id: 'aaa', updatedAt: sameTime });
    const b = makeChatItem({ id: 'zzz', updatedAt: sameTime });
    const result = mergeChatsById([a, b]);
    expect(result.map((x) => x.id)).toEqual(['zzz', 'aaa']);
  });
});

describe('bumpChatUpdatedAtInFolderMap', () => {
  it('returns the same reference when chatId is not in any folder', () => {
    const map = {
      a: [makeChatItem({ id: 'x', updatedAt: new Date('2025-01-01') })],
    };
    const next = bumpChatUpdatedAtInFolderMap(map, 'missing', new Date('2025-12-01'));
    expect(next).toBe(map);
  });

  it('updates updatedAt and moves chat to top of that folder list', () => {
    const old = new Date('2025-01-01');
    const newer = new Date('2025-08-01');
    const map = {
      f1: [
        makeChatItem({ id: 'a', updatedAt: newer, name: 'A' }),
        makeChatItem({ id: 'b', updatedAt: old, name: 'B' }),
      ],
    };
    const bumpTime = new Date('2025-09-01');
    const next = bumpChatUpdatedAtInFolderMap(map, 'b', bumpTime);
    expect(next).not.toBe(map);
    expect(next.f1[0].id).toBe('b');
    expect(next.f1[0].updatedAt).toEqual(bumpTime);
    expect(next.f1[1].id).toBe('a');
  });

  it('updates the chat in every folder that contains it', () => {
    const t = new Date('2025-10-01');
    const chat = makeChatItem({ id: 'same', updatedAt: new Date('2025-01-01') });
    const map = {
      f1: [chat],
      f2: [{ ...chat }],
    };
    const next = bumpChatUpdatedAtInFolderMap(map, 'same', t);
    expect(next.f1[0].updatedAt).toEqual(t);
    expect(next.f2[0].updatedAt).toEqual(t);
  });
});

describe('buildChatTaskStatusMap — flow-run-authoritative badge', () => {
  it('substitutes a done task to running while its flow_run is non-terminal (no premature Done)', () => {
    expect(
      buildChatTaskStatusMap([
        { status: 'done', linkedChatId: 'c1', flowRunStatus: 'running' },
      ]).get('c1'),
    ).toBe('running');
    expect(
      buildChatTaskStatusMap([{ status: 'done', linkedChatId: 'c1', flowRunStatus: 'paused' }]).get(
        'c1',
      ),
    ).toBe('running');
  });

  it('keeps done when the flow_run is completed or absent / non-flow (no regression)', () => {
    expect(
      buildChatTaskStatusMap([
        { status: 'done', linkedChatId: 'c1', flowRunStatus: 'completed' },
      ]).get('c1'),
    ).toBe('done');
    expect(
      buildChatTaskStatusMap([{ status: 'done', linkedChatId: 'c1', flowRunStatus: null }]).get(
        'c1',
      ),
    ).toBe('done');
    expect(buildChatTaskStatusMap([{ status: 'done', linkedChatId: 'c1' }]).get('c1')).toBe('done');
  });

  it('substitutes a done task to cancelled when the flow_run was cancelled (matches runs-history)', () => {
    expect(
      buildChatTaskStatusMap([
        { status: 'done', linkedChatId: 'c1', flowRunStatus: 'cancelled' },
      ]).get('c1'),
    ).toBe('cancelled');
  });

  it('substitutes a done task to failed when the flow_run failed (non-agent-node failure has no failed task)', () => {
    // A flow that fails at a non-agent node (condition/http/edge-missing) creates no `failed` task, so
    // only the first agent`s `done` task is present — without the substitution the chat would show a
    // misleading green Done for a failed run.
    expect(
      buildChatTaskStatusMap([{ status: 'done', linkedChatId: 'c1', flowRunStatus: 'failed' }]).get(
        'c1',
      ),
    ).toBe('failed');
  });

  it('a real failed agent task still wins over a done sibling (no regression from the failed substitution)', () => {
    const map = buildChatTaskStatusMap([
      { status: 'done', linkedChatId: 'c1', flowRunStatus: 'failed' },
      { status: 'failed', linkedChatId: 'c1', flowRunStatus: 'failed' },
    ]);
    expect(map.get('c1')).toBe('failed');
  });

  it('a live plan_ready sibling still wins over a substituted running', () => {
    const map = buildChatTaskStatusMap([
      { status: 'done', linkedChatId: 'c1', flowRunStatus: 'paused' },
      { status: 'plan_ready', linkedChatId: 'c1', flowRunStatus: 'paused' },
    ]);
    expect(map.get('c1')).toBe('plan_ready');
  });

  it('skips tasks missing linkedChatId or status', () => {
    expect(buildChatTaskStatusMap([{ status: 'done' }, { linkedChatId: 'c1' }]).size).toBe(0);
  });

  it('fills a blank for a chat with an active flow_run but no task (taskless window)', () => {
    const map = buildChatTaskStatusMap([], ['c1']);
    expect(map.get('c1')).toBe('running');
  });

  it('never overrides a real task status with the flow-active fill', () => {
    const map = buildChatTaskStatusMap(
      [{ status: 'needs_attention', linkedChatId: 'c1', flowRunStatus: 'paused' }],
      ['c1'],
    );
    expect(map.get('c1')).toBe('needs_attention');
  });

  it('maps a failed anchor to cancelled once the flow_run was cancelled', () => {
    expect(
      buildChatTaskStatusMap([
        { status: 'failed', linkedChatId: 'c1', flowRunStatus: 'cancelled' },
      ]).get('c1'),
    ).toBe('cancelled');
  });

  it('maps a failed anchor to done once the flow_run completed', () => {
    expect(
      buildChatTaskStatusMap([
        { status: 'failed', linkedChatId: 'c1', flowRunStatus: 'completed' },
      ]).get('c1'),
    ).toBe('done');
  });

  it('keeps a failed anchor as failed under a live run (the newest attempt failed)', () => {
    expect(
      buildChatTaskStatusMap([
        { status: 'failed', linkedChatId: 'c1', flowRunStatus: 'paused' },
      ]).get('c1'),
    ).toBe('failed');
    expect(
      buildChatTaskStatusMap([
        { status: 'failed', linkedChatId: 'c1', flowRunStatus: 'running' },
      ]).get('c1'),
    ).toBe('failed');
  });

  it('keeps a non-flow failed task as failed (no flow_run to defer to)', () => {
    expect(buildChatTaskStatusMap([{ status: 'failed', linkedChatId: 'c1' }]).get('c1')).toBe(
      'failed',
    );
  });

  it('a stale failed pin and a done retry sibling both resolve to cancelled at a terminal run', () => {
    // A retry links a new task by result.chatId while the old failed task stays pinned; once the run
    // reaches a terminal state the stale failed no longer outranks the retry outcome by priority.
    const map = buildChatTaskStatusMap([
      { status: 'failed', linkedChatId: 'c1', flowRunStatus: 'cancelled' },
      { status: 'done', linkedChatId: 'c1', flowRunStatus: 'cancelled' },
    ]);
    expect(map.get('c1')).toBe('cancelled');
  });

  it('a failed pin still wins under a live paused run over a done sibling', () => {
    // Not superseded (the server did not demote it), so under a live run the pill stays failed,
    // matching the backend effectiveStatusExpr so the sidebar and work-queue never disagree.
    const map = buildChatTaskStatusMap([
      { status: 'failed', linkedChatId: 'c1', flowRunStatus: 'paused', effectiveStatus: 'failed' },
      { status: 'done', linkedChatId: 'c1', flowRunStatus: 'paused', effectiveStatus: 'running' },
    ]);
    expect(map.get('c1')).toBe('failed');
  });

  it('an attempt a retry superseded reads running under a live run', () => {
    const map = buildChatTaskStatusMap([
      {
        status: 'running',
        linkedChatId: 'c1',
        flowRunStatus: 'running',
        effectiveStatus: 'running',
      },
      {
        status: 'failed',
        linkedChatId: 'c1',
        flowRunStatus: 'running',
        effectiveStatus: 'running',
      },
      {
        status: 'needs_attention',
        linkedChatId: 'c2',
        flowRunStatus: 'paused',
        effectiveStatus: 'running',
      },
    ]);
    expect(map.get('c1')).toBe('running');
    expect(map.get('c2')).toBe('running');
  });

  it('a pending task under a live run keeps its pending pill', () => {
    expect(
      buildChatTaskStatusMap([
        {
          status: 'pending',
          linkedChatId: 'c1',
          flowRunStatus: 'running',
          effectiveStatus: 'running',
        },
      ]).get('c1'),
    ).toBe('pending');
  });
});

describe('buildChatReasonMap — park reason of the winning task per chat', () => {
  it('returns the agent summary + details for a parked task', () => {
    const map = buildChatReasonMap([
      {
        status: 'needs_attention',
        linkedChatId: 'c1',
        result: { agentSignal: { summary: 'Approve plan #143', details: 'the full plan' } },
      },
    ]);
    expect(map.get('c1')).toEqual({ summary: 'Approve plan #143', details: 'the full plan' });
  });

  it('picks the highest-priority winning task (needs_attention over running)', () => {
    const map = buildChatReasonMap([
      {
        status: 'running',
        linkedChatId: 'c1',
        result: { agentSignal: { summary: 'still working' } },
      },
      {
        status: 'needs_attention',
        linkedChatId: 'c1',
        result: { agentSignal: { summary: 'the ask' } },
      },
    ]);
    expect(map.get('c1')?.summary).toBe('the ask');
  });

  it('mirrors the done→running substitution so a live plan_ready sibling wins the reason', () => {
    const map = buildChatReasonMap([
      {
        status: 'done',
        linkedChatId: 'c1',
        flowRunStatus: 'paused',
        result: { agentSignal: { summary: 'done summary' } },
      },
      {
        status: 'plan_ready',
        linkedChatId: 'c1',
        flowRunStatus: 'paused',
        result: { agentSignal: { summary: 'plan ask' } },
      },
    ]);
    expect(map.get('c1')?.summary).toBe('plan ask');
  });

  it('returns undefined summary/details when the winning task has no agentSignal', () => {
    const map = buildChatReasonMap([{ status: 'running', linkedChatId: 'c1' }]);
    expect(map.get('c1')).toEqual({ summary: undefined, details: undefined });
  });

  it('ignores tasks with no linkedChatId or status', () => {
    const map = buildChatReasonMap([
      { status: 'needs_attention', result: { agentSignal: { summary: 'x' } } },
      { linkedChatId: 'c2', result: { agentSignal: { summary: 'y' } } },
    ]);
    expect(map.size).toBe(0);
  });
});

// The pill (buildChatTaskStatusMap) and its tooltip reason (buildChatReasonMap) must resolve the SAME
// winning task — both run flowAwareStatus + STATUS_PRIORITY over the same list. These exercise the
// failed-anchor branch through BOTH consumers (the reason map otherwise has no failed-anchor coverage).
describe('failed-anchor wiring: status pill and reason map stay in agreement', () => {
  it('keeps a failed anchor authoritative under a live run — pill AND reason come from it (over a done sibling)', () => {
    // The newest attempt failed: the failed anchor carries the actionable reason; a done sibling
    // must not demote the pill to green nor steal the reason while the run is still live (paused).
    const tasks = [
      {
        status: 'failed',
        linkedChatId: 'c1',
        flowRunStatus: 'paused',
        result: { agentSignal: { summary: 'connect account', details: 'auth expired' } },
      },
      {
        status: 'done',
        linkedChatId: 'c1',
        flowRunStatus: 'paused',
        result: { agentSignal: { summary: 'retry running' } },
      },
    ];
    expect(buildChatTaskStatusMap(tasks).get('c1')).toBe('failed');
    expect(buildChatReasonMap(tasks).get('c1')).toEqual({
      summary: 'connect account',
      details: 'auth expired',
    });
  });

  it('a live needs_attention sibling outranks a failed anchor in BOTH the pill and the reason', () => {
    // A later flow node parks (needs_attention) while an earlier node's task is failed: the live park
    // must win the pill and its reason — the failed anchor must not shadow it.
    const tasks = [
      {
        status: 'failed',
        linkedChatId: 'c1',
        flowRunStatus: 'paused',
        result: { agentSignal: { summary: 'stale failure' } },
      },
      {
        status: 'needs_attention',
        linkedChatId: 'c1',
        flowRunStatus: 'paused',
        result: { agentSignal: { summary: 'approve plan' } },
      },
    ];
    expect(buildChatTaskStatusMap(tasks).get('c1')).toBe('needs_attention');
    expect(buildChatReasonMap(tasks).get('c1')?.summary).toBe('approve plan');
  });

  it('at a terminal run both a failed pin and a done retry resolve to the SAME cancelled winner', () => {
    // A cancelled run whose chat is linked to both a stale failed pin and a done retry: the pill and
    // reason must agree on the same winning task, not diverge.
    const tasks = [
      {
        status: 'failed',
        linkedChatId: 'c1',
        flowRunStatus: 'cancelled',
        result: { agentSignal: { summary: 'first attempt failed' } },
      },
      {
        status: 'done',
        linkedChatId: 'c1',
        flowRunStatus: 'cancelled',
        result: { agentSignal: { summary: 'retry done' } },
      },
    ];
    expect(buildChatTaskStatusMap(tasks).get('c1')).toBe('cancelled');
    expect(buildChatReasonMap(tasks).get('c1')?.summary).toBe('first attempt failed');
  });

  it('after a retry, the pill and reason come from the live attempt, not the superseded failure', () => {
    // The poll lists newest first; the superseded failure now ties on `running`, so the newer wins.
    const tasks = [
      {
        status: 'running',
        linkedChatId: 'c1',
        flowRunStatus: 'running',
        effectiveStatus: 'running',
        result: { agentSignal: { summary: 'retry running' } },
      },
      {
        status: 'failed',
        linkedChatId: 'c1',
        flowRunStatus: 'running',
        effectiveStatus: 'running',
        result: { agentSignal: { summary: 'first attempt failed' } },
      },
    ];
    expect(buildChatTaskStatusMap(tasks).get('c1')).toBe('running');
    expect(buildChatReasonMap(tasks).get('c1')?.summary).toBe('retry running');
  });
});

describe('buildPendingQuestionChatIds', () => {
  // The atom is keyed by toolUseId and carries BOTH ids; the sidebar renders PARENT chat rows, so
  // keying the set by anything but parentChatId flags the wrong row (or none at all).
  it('keys the set by parentChatId, not the sub-chat or tool id', () => {
    const ids = buildPendingQuestionChatIds(
      new Map([['tool-1', { subChatId: 'sub-1', parentChatId: 'chat-1' }]]),
    );
    expect([...ids]).toEqual(['chat-1']);
    expect(ids.has('sub-1')).toBe(false);
    expect(ids.has('tool-1')).toBe(false);
  });

  it('collapses parallel questions on one chat to a single row id', () => {
    // A Claude turn can hold several AskUserQuestion calls at once, each its own atom entry.
    const ids = buildPendingQuestionChatIds(
      new Map([
        ['tool-1', { subChatId: 'sub-1', parentChatId: 'chat-1' }],
        ['tool-2', { subChatId: 'sub-2', parentChatId: 'chat-1' }],
      ]),
    );
    expect(ids.size).toBe(1);
    expect(ids.has('chat-1')).toBe(true);
  });

  it('flags every chat that has a held question', () => {
    const ids = buildPendingQuestionChatIds(
      new Map([
        ['tool-1', { subChatId: 'sub-1', parentChatId: 'chat-1' }],
        ['tool-2', { subChatId: 'sub-2', parentChatId: 'chat-2' }],
      ]),
    );
    expect([...ids].sort()).toEqual(['chat-1', 'chat-2']);
  });

  it('returns an empty set when nothing is held (the common idle case)', () => {
    expect(buildPendingQuestionChatIds(new Map()).size).toBe(0);
  });
});

describe('sameSidebarTasks', () => {
  const task = (overrides: Partial<SidebarPolledTask> = {}): SidebarPolledTask => ({
    id: 'task-1',
    status: 'running',
    linkedChatId: 'chat-1',
    flowRunStatus: null,
    ...overrides,
  });

  it('treats a re-fetched list with identical content as unchanged', () => {
    expect(sameSidebarTasks([task()], [task()])).toBe(true);
  });

  it('detects length and field changes', () => {
    expect(sameSidebarTasks([task()], [])).toBe(false);
    expect(sameSidebarTasks([task()], [task({ status: 'done' })])).toBe(false);
    expect(sameSidebarTasks([task()], [task({ flowRunStatus: 'failed' })])).toBe(false);
    expect(sameSidebarTasks([task()], [task({ effectiveStatus: 'running' })])).toBe(false);
    expect(sameSidebarTasks([task()], [task({ linkedChatId: 'chat-2' })])).toBe(false);
  });

  /**
   * Compared per index, so a reorder reads as changed. Safe only because listPaginated pages on a
   * (createdAt, id) cursor; if ordering ever becomes unstable this is where it surfaces.
   */
  it('treats a reordered list as changed', () => {
    const a = task({ id: 'task-1' });
    const b = task({ id: 'task-2', linkedChatId: 'chat-2' });
    expect(sameSidebarTasks([a, b], [b, a])).toBe(false);
  });

  // The sidebar narrows the payload with optional fields, so an absent key and an explicit null
  // describe the same task. Treating them as different would re-mint the array on every poll.
  it('treats an absent optional field and an explicit null as the same task', () => {
    // Built raw, not via the fixture: the fixture supplies `flowRunStatus: null` for both sides,
    // which would make this pass without comparing anything.
    const withNull: SidebarPolledTask = { id: 't', status: 'running', flowRunStatus: null };
    const withAbsent: SidebarPolledTask = { id: 't', status: 'running' };
    expect(sameSidebarTasks([withNull], [withAbsent])).toBe(true);
    expect(sameSidebarTasks([task({ result: null })], [task({})])).toBe(true);
  });

  it('handles an empty list on both sides', () => {
    expect(sameSidebarTasks([], [])).toBe(true);
  });

  // A re-parked task can change only its reason; missing that would freeze the pill tooltip,
  // because the reason map is rebuilt from this list and nothing else carries the signal.
  it('detects an agentSignal change while every other field holds', () => {
    const parked = task({ result: { agentSignal: { summary: 'waiting', details: 'on input' } } });
    const reparked = task({ result: { agentSignal: { summary: 'blocked', details: 'on input' } } });
    expect(sameSidebarTasks([parked], [reparked])).toBe(false);
    expect(sameSidebarTasks([parked], [task({ ...parked })])).toBe(true);
  });
});
