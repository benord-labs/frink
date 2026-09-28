import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_AGENT_PROSE_LENGTH } from '../../../../shared/lib/flows/agent-prose-limit';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { chats } from '../../db/schema';
import { seedCompletedNodeRun, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const { h } = vi.hoisted(() => ({ h: { db: null as unknown, createTask: vi.fn() } }));

vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => h.db,
}));
vi.mock('../../db/repos/tasks', async (orig) => ({
  ...(await orig<typeof import('../../db/repos/tasks')>()),
  createTask: h.createTask,
}));

import { dispatchAgent } from './agent';

// sc-3166: agent prose used to be sliced at the generic 10k template cap, silently.

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'ag1', blockType: 'agent', position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 'st', target: 'ag1' }],
};

let db: TestDb;
let flowRunId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  h.db = db;
  h.createTask.mockResolvedValue({ id: 'task-new' });
  let projectId: string;
  ({ projectId, flowRunId } = await seedFlowRun(db, GRAPH));
  await seedCompletedNodeRun(db, {
    flowRunId,
    nodeId: 'st',
    blockType: 'start_task',
    outputs: { chatId: 'chat-1', subChatId: 'sub-1', worktreePath: '/wt/abc', projectId },
  });
  await db.insert(chats).values({ id: 'chat-1', name: 'flow chat' });
});

const PREV = {
  status: 'completed' as const,
  outputs: { summary: 'PREVIOUS-SUMMARY' },
  artifacts: [],
  durationMs: 0,
};

async function dispatchWith(config: Record<string, unknown>, previousOutput: unknown = PREV) {
  const res = await dispatchAgent({
    flowRunId,
    nodeRunId: 'ag1-nr',
    node: { id: 'ag1', blockType: 'agent', label: 'Build', config },
    previousOutput,
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: GRAPH,
    signal: new AbortController().signal,
    // SAFETY: supplies every DispatchContext field dispatchAgent reads.
  } as never);
  // SAFETY: createTask is a vi.fn(); dispatchAgent always passes a string description.
  const description = h.createTask.mock.calls[0]?.[1]?.description as string | undefined;
  return { res, description };
}

describe('agent prose over the 10k template cap reaches the agent in full', () => {
  it('keeps the tail — including a placeholder past 10k, which used to be cut mid-token', async () => {
    const body = `${'a'.repeat(15_000)} then use {{previous.summary}} TAIL-MARKER`;
    const { res, description } = await dispatchWith({ instructions: body });

    expect(res.type).not.toBe('error');
    expect(description).toContain('then use PREVIOUS-SUMMARY TAIL-MARKER');
    expect(description).not.toContain('{{previous.');
    expect(description?.endsWith('TAIL-MARKER')).toBe(true);
  });

  it('keeps a long Role prefix (agentInstructions) in full', async () => {
    const role = `${'r'.repeat(15_000)}ROLE-TAIL`;
    const { res, description } = await dispatchWith({
      instructions: 'do it',
      agentInstructions: role,
    });

    expect(res.type).not.toBe('error');
    expect(description).toContain('ROLE-TAIL\n\n---\n\ndo it');
  });

  it('dispatches instructions exactly at the cap in full', async () => {
    const body = `${'a'.repeat(MAX_AGENT_PROSE_LENGTH - 3)}END`;
    const { res, description } = await dispatchWith({ instructions: body });

    expect(res.type).not.toBe('error');
    expect(description).toHaveLength(MAX_AGENT_PROSE_LENGTH);
  });

  it('whitespace padding does not count: a cap-sized prompt with trailing blank lines dispatches', async () => {
    const body = `${'a'.repeat(MAX_AGENT_PROSE_LENGTH)}\n\n\n    `;
    const { res } = await dispatchWith({ instructions: body });

    expect(res.type).not.toBe('error');
  });

  it('a Role prefix exactly at the cap is not sliced even with padding around it', async () => {
    const role = `\n  ${'r'.repeat(MAX_AGENT_PROSE_LENGTH - 9)}ROLE-TAIL  \n`;
    const { res, description } = await dispatchWith({ instructions: 'x', agentInstructions: role });

    expect(res.type).not.toBe('error');
    expect(description).toContain('ROLE-TAIL');
  });

  it('a short template expanding a large previous output is not truncated', async () => {
    const big = 's'.repeat(30_000);
    const { res, description } = await dispatchWith(
      { instructions: 'Review: {{previous.summary}} END' },
      { ...PREV, outputs: { summary: big } },
    );

    expect(res.type).not.toBe('error');
    expect(description).toBe(`Review: ${big} END`);
  });

  it('the cap bounds the authored template, not the output: large resolved values render whole', async () => {
    const a = 'a'.repeat(40_000);
    const b = 'b'.repeat(40_000);
    const { res, description } = await dispatchWith(
      { instructions: '{{previous.first}}|{{previous.second}}' },
      { ...PREV, outputs: { first: a, second: b } },
    );

    expect(res.type).not.toBe('error');
    expect(description).toBe(`${a}|${b}`);
  });
});

describe('agent prose over the explicit cap fails closed, naming the limit', () => {
  it('instructions one character over: errors and never creates a task', async () => {
    const { res } = await dispatchWith({ instructions: 'a'.repeat(MAX_AGENT_PROSE_LENGTH + 1) });

    expect(res).toMatchObject({ type: 'error' });
    expect((res as { message: string }).message).toBe(
      'agent: instructions is 50,001 characters; the limit is 50,000 — shorten it',
    );
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it('agentInstructions over the cap: errors naming agentInstructions', async () => {
    const { res } = await dispatchWith({
      instructions: 'do it',
      agentInstructions: 'r'.repeat(MAX_AGENT_PROSE_LENGTH + 1),
    });

    expect((res as { message: string }).message).toContain('agentInstructions is 50,001');
    expect(h.createTask).not.toHaveBeenCalled();
  });
});
