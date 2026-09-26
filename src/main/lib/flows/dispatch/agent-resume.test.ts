import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { chats, nodeRuns, subChats, tasks } from '../../db/schema';
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

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'ag1', blockType: 'agent', position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 'st', target: 'ag1' }],
};

const START_TASK_OUTPUTS = {
  chatId: 'chat-1',
  subChatId: 'sub-1',
  worktreePath: '/wt/abc',
  startMode: 'plan',
};

let db: TestDb;
let projectId: string;
let flowRunId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  h.db = db;
  h.createTask.mockResolvedValue({ id: 'task-new' });
  ({ projectId, flowRunId } = await seedFlowRun(db, GRAPH));
  await seedCompletedNodeRun(db, {
    flowRunId,
    nodeId: 'st',
    blockType: 'start_task',
    outputs: { ...START_TASK_OUTPUTS, projectId },
  });
  await db.insert(chats).values({ id: 'chat-1', name: 'flow chat' });
});

/** Sub-chat + prior failed attempt of ag1 whose task drove that sub-chat's session. */
async function seedPriorAttempt(opts: {
  sessionId?: string | null;
  subChatMode?: string;
  taskNodeId?: string;
  priorError?: string;
}): Promise<void> {
  await db.insert(subChats).values({
    id: 'sub-1',
    chatId: 'chat-1',
    mode: (opts.subChatMode ?? 'agent') as never,
    sessionId: opts.sessionId === undefined ? 'sess-1' : opts.sessionId,
    messages: '[]',
  });
  const priorNodeRunId = 'nr-prior';
  await db.insert(nodeRuns).values({
    id: priorNodeRunId,
    flowRunId,
    nodeId: opts.taskNodeId ?? 'ag1',
    blockType: 'agent',
    status: 'failed',
  });
  await db.insert(tasks).values({
    id: 'task-prior',
    description: 'prior attempt',
    source: 'flow',
    status: 'cancelled',
    flowRunId,
    sourceId: priorNodeRunId,
    result: { subChatId: 'sub-1', ...(opts.priorError ? { error: opts.priorError } : {}) },
  });
}

function agentCtx(over: Record<string, unknown> = {}) {
  return {
    flowRunId,
    nodeRunId: 'ag1-nr-retry',
    node: {
      id: 'ag1',
      blockType: 'agent',
      label: 'Build',
      config: { instructions: 'do it', mode: 'plan', autoApprove: true },
    },
    previousOutput: undefined,
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: GRAPH,
    signal: new AbortController().signal,
    ...over,
  };
}

async function dispatched(over: Record<string, unknown> = {}) {
  const res = await dispatchAgent(agentCtx(over) as never);
  expect(res.type).not.toBe('error');
  const arg = h.createTask.mock.calls[0][1];
  return {
    description: arg.description as string,
    cfg: arg.triggerContext._config as Record<string, unknown>,
  };
}

describe('continuation terminal-resume dispatch (resumeKind: continuation)', () => {
  it('live session + this node drove it → _config.resumeSession, live mode replaces the plan gate, instructions stay in the description', async () => {
    await seedPriorAttempt({ subChatMode: 'agent', priorError: 'crashed mid-write' });

    const { description, cfg } = await dispatched({ resumeKind: 'continuation' });

    expect(cfg.resumeSession).toBe(true);
    expect(cfg.resumeSubChatId).toBe('sub-1');
    expect(cfg.resumePriorError).toBe('crashed mid-write');
    // startMode stays the CONFIGURED mode; the clamped live mode rides resumeStartMode and
    // is applied at claim only when the pick lands on the pinned sub-chat.
    expect(cfg.startMode).toBe('plan');
    expect(cfg.resumeStartMode).toBe('execute');
    // Review semantics stay keyed on the CONFIGURED mode (plan+autoApprove), not the seed.
    expect(cfg.skipReview).toBe(true);
    // The task row remains the honest record — no framing, no nudge here.
    expect(description).toContain('do it');
    expect(description).not.toContain('re-run from its instructions');
  });

  it('live session still in plan mode → no mode override (configured plan kept)', async () => {
    await seedPriorAttempt({ subChatMode: 'plan' });
    const { cfg } = await dispatched({ resumeKind: 'continuation' });
    expect(cfg.resumeSession).toBe(true);
    expect(cfg.startMode).toBe('plan');
    expect(cfg.resumeStartMode).toBeUndefined();
  });

  it('no surviving session → full re-dispatch, no resumeSession, configured mode kept, no framing', async () => {
    await seedPriorAttempt({ sessionId: null });
    const { description, cfg } = await dispatched({ resumeKind: 'continuation' });
    expect(cfg.resumeSession).toBeUndefined();
    expect(cfg.startMode).toBe('plan');
    expect(description.startsWith('This step is being re-run')).toBe(false);
  });

  it('session exists but its newest task drove a DIFFERENT node → no resumeSession AND no framing (the session holds unrelated work — disowning it would be a false claim)', async () => {
    await seedPriorAttempt({ taskNodeId: 'st' });
    // ag1 itself also ran before (that is what makes this dispatch a redispatch).
    await db.insert(nodeRuns).values({
      id: 'nr-ag1-old',
      flowRunId,
      nodeId: 'ag1',
      blockType: 'agent',
      status: 'failed',
    });

    const { description, cfg } = await dispatched({ resumeKind: 'continuation' });

    expect(cfg.resumeSession).toBeUndefined();
    expect(description.startsWith('This step is being re-run')).toBe(false);
    expect(description).toContain('do it');
  });
});

describe('deliberate re-run dispatch (resumeKind: redispatch)', () => {
  it('surviving session holding THIS node+run → restart framing prefixed, never resumeSession', async () => {
    await seedPriorAttempt({});
    const { description, cfg } = await dispatched({ resumeKind: 'redispatch' });
    expect(cfg.resumeSession).toBeUndefined();
    expect(cfg.startMode).toBe('plan');
    expect(description.startsWith('This step is being re-run')).toBe(true);
  });

  it('no surviving session → no framing (nothing to contradict)', async () => {
    await seedPriorAttempt({ sessionId: null });
    const { description } = await dispatched({ resumeKind: 'redispatch' });
    expect(description.startsWith('This step is being re-run')).toBe(false);
  });

  it('session last driven by a different node → no framing (same gate as the seed)', async () => {
    await seedPriorAttempt({ taskNodeId: 'st' });
    const { description } = await dispatched({ resumeKind: 'redispatch' });
    expect(description.startsWith('This step is being re-run')).toBe(false);
  });
});

describe('engine advances carry no resumeKind and are untouched', () => {
  it('loop-style re-dispatch (prior node_run, live session, NO resumeKind) → no seed, no framing', async () => {
    await seedPriorAttempt({});
    const { description, cfg } = await dispatched({});
    expect(cfg.resumeSession).toBeUndefined();
    expect(cfg.isNodeRedispatch).toBe(true);
    expect(description.startsWith('This step is being re-run')).toBe(false);
    expect(description).toContain('do it');
  });
});

// sc-2706: an absent `{{previous.*}}` reached the agent as literal, path-shaped text it could act
// on. It must render empty — and still run, since these fields are often `guaranteed: false`.
describe('agent prompts never carry an unresolved placeholder', () => {
  /** Only summary is emitted: worktreePath/branch are `guaranteed: false` in output-schemas.ts. */
  const AGENT_PREV = {
    status: 'completed' as const,
    outputs: { summary: 'evaluated' },
    artifacts: [],
    durationMs: 0,
  };

  async function promptFor(instructions: string) {
    const res = await dispatchAgent(
      // SAFETY: agentCtx supplies every DispatchContext field this dispatcher reads.
      agentCtx({
        previousOutput: AGENT_PREV,
        node: { id: 'ag1', blockType: 'agent', label: 'Build', config: { instructions } },
      }) as never,
    );
    // SAFETY: createTask is a vi.fn() so its recorded args are untyped; every dispatchAgent path
    // reaching it passes a string description, built by renderTemplate in agent.ts.
    const description = h.createTask.mock.calls[0]?.[1]?.description as string;
    return { res, description };
  }

  it('renders an absent output as empty, not as literal placeholder text', async () => {
    const { res, description } = await promptFor(
      'You are working in `{{previous.worktreePath}}` on branch `{{previous.branch}}`.',
    );

    expect(res.type).not.toBe('error');
    expect(description).not.toContain('{{previous.');
    expect(description).toContain('You are working in `` on branch ``.');
  });

  it('still substitutes the outputs the predecessor did produce', async () => {
    const { description } = await promptFor('{{previous.summary}} / {{previous.missing}}');
    expect(description).toBe('evaluated / ');
  });

  it('runs the node rather than failing it — an absent optional output is not an author error', async () => {
    const { res } = await promptFor('check {{previous.taskStatus}}');
    expect(res.type).not.toBe('error');
    expect(h.createTask).toHaveBeenCalledTimes(1);
  });
});
