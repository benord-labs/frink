import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { isValidTriggerContext } from '../../../../shared/types/trigger-context';
import { createChat, getChatById } from '../../db/repos/chats';
import { getOrCreateFlowRunByIdempotencyKey } from '../../db/repos/flow-runs';
import { createFlowVersion } from '../../db/repos/flow-versions';
import { createFlow } from '../../db/repos/flows';
import {
  createNodeRun,
  findLatestCompletedStartTaskRun,
  resolveUpstreamStartTaskContext,
  setNodeRunStatus,
} from '../../db/repos/node-runs';
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

import { findUpstreamNodeIds } from '../graph';
import { dispatchAgent } from './agent';

// start_task → agent → condition → agent — the shape that crashes today (agent #2+
// can't read context past the condition / preceding agent).
const GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'ag1', blockType: 'agent', position: { x: 0, y: 1 } },
    { id: 'cond', blockType: 'condition', position: { x: 0, y: 2 } },
    { id: 'ag2', blockType: 'agent', position: { x: 0, y: 3 } },
  ],
  edges: [
    { id: 'e1', source: 'st', target: 'ag1' },
    { id: 'e2', source: 'ag1', target: 'cond' },
    { id: 'e3', source: 'cond', target: 'ag2' },
  ],
};

const FAN_OUT_GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'fo', blockType: 'fan_out', position: { x: 0, y: 1 } },
    {
      id: 'ag-fan',
      blockType: 'agent',
      parentId: 'fo',
      position: { x: 0, y: 2 },
      config: { instructions: 'do it' },
    },
  ],
  edges: [
    { id: 'e1', source: 'st', target: 'fo' },
    { id: 'e2', source: 'fo', target: 'ag-fan' },
  ],
};

const START_TASK_OUTPUTS = {
  projectId: 'will-be-overwritten',
  chatId: 'chat-1',
  subChatId: 'sub-1',
  worktreePath: '/wt/abc',
  branch: 'b',
  baseBranch: 'main',
  startMode: 'plan',
};

// What a completed agent task looks like once mapTaskToNodeOutput runs — note it
// carries NO projectId/chatId, which is exactly why immediate-predecessor reads fail.
const AGENT_PREV_OUTPUT = {
  status: 'completed' as const,
  outputs: { summary: 'evaluated', details: 'looks good' },
  artifacts: [],
  durationMs: 0,
};
const CONDITION_PREV_OUTPUT = {
  status: 'completed' as const,
  outputs: { result: 'continue', passed: true },
  artifacts: [],
  durationMs: 0,
};

let db: TestDb;
let projectId: string;
let flowRunId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  h.db = db;
  h.createTask.mockResolvedValue({ id: 'task-1' });

  ({ projectId, flowRunId } = await seedFlowRun(db, GRAPH));
});

function seedNodeRun(
  nodeId: string,
  blockType: string,
  outputs: Record<string, unknown>,
  completedAt = new Date(),
) {
  return seedCompletedNodeRun(db, { flowRunId, nodeId, blockType, outputs, completedAt });
}

function seedStartTask(over: Record<string, unknown> = {}) {
  return seedNodeRun('st', 'start_task', { ...START_TASK_OUTPUTS, projectId, ...over });
}

function agentCtx(over: Record<string, unknown> = {}) {
  return {
    flowRunId,
    nodeRunId: 'ag2-nr',
    userId: 'u1',
    node: { id: 'ag2', blockType: 'agent', label: 'Build', config: { instructions: 'do it' } },
    previousOutput: undefined,
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: GRAPH,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('local dispatch — flow briefing rides _config, not the message', () => {
  const BRIEFING = 'PRD: always use object destructuring';
  const GRAPH_WITH_BRIEFING: FlowGraph = { ...GRAPH, settings: { briefing: BRIEFING } };

  // Seed a fresh flow run whose version carries `graph` (with the briefing), REUSING the project the
  // file-level beforeEach already created — a second seedFlowRun would collide on the fixed project path.
  async function dispatchWithBriefing(
    instructions: string,
    graph: FlowGraph = GRAPH_WITH_BRIEFING,
  ) {
    const flow = await createFlow(db, { name: 'FB' });
    const version = await createFlowVersion(db, { flowId: flow.id, graph });
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: version.id,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'kb',
      startedAt: new Date(),
    });
    await seedCompletedNodeRun(db, {
      flowRunId: run.id,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { ...START_TASK_OUTPUTS, projectId },
    });
    await dispatchAgent(
      // SAFETY: agentCtx supplies the complete dispatcher context; this override changes valid fields.
      agentCtx({
        flowRunId: run.id,
        previousOutput: AGENT_PREV_OUTPUT,
        node: { id: 'ag2', blockType: 'agent', label: 'Build', config: { instructions } },
      }) as never,
    );
    return h.createTask.mock.calls[0][1];
  }

  it('stashes the rendered briefing in _config.flowBriefing and keeps it out of the description', async () => {
    const arg = await dispatchWithBriefing('implement it');
    expect(arg.triggerContext._config.flowBriefing).toBe(BRIEFING);
    expect(arg.description).not.toContain('## Flow Briefing');
    expect(arg.description).not.toContain(BRIEFING);
    expect(arg.description).toContain('implement it');
  });

  it('{{flow.briefing}} in instructions resolves to empty (retired) — no briefing echo in the message', async () => {
    const arg = await dispatchWithBriefing('Spec: {{flow.briefing}} done');
    expect(arg.description).not.toContain(BRIEFING);
    expect(arg.description).toContain('Spec:  done');
    expect(arg.triggerContext._config.flowBriefing).toBe(BRIEFING);
  });

  it('no briefing set → no flowBriefing in _config', async () => {
    const arg = await dispatchWithBriefing('implement it', GRAPH);
    expect(arg.triggerContext._config.flowBriefing).toBeUndefined();
  });
});

describe('local dispatch — Flow Auto Mode', () => {
  it('defaults legacy Flow graphs to Auto on and preserves explicit disablement', async () => {
    await seedStartTask();
    await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);
    expect(h.createTask.mock.calls[0][1].triggerContext._config.autoReviewTools).toBe(true);

    h.createTask.mockClear();
    await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        parsedGraph: { ...GRAPH, settings: { autoReviewTools: false } },
      }) as never,
    );
    expect(h.createTask.mock.calls[0][1].triggerContext._config.autoReviewTools).toBe(false);
  });
});

describe('local dispatch — Flow Codex Fast mode', () => {
  it('emits an explicit false when unset, so a chat left on Fast is actively cleared', async () => {
    // The value seeds the chat's persisted Fast atom. Emitting nothing here would let a chat that a
    // previous Fast run switched on keep billing this run at the priority multiplier.
    await seedStartTask();
    await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);
    expect(h.createTask.mock.calls[0][1].triggerContext._config.codexFastMode).toBe(false);
  });

  it('forwards an enabled Fast setting', async () => {
    await seedStartTask();
    await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        parsedGraph: { ...GRAPH, settings: { codexFastMode: true } },
      }) as never,
    );
    expect(h.createTask.mock.calls[0][1].triggerContext._config.codexFastMode).toBe(true);
  });

  it('treats a non-boolean setting as off rather than truthy', async () => {
    // validate-flow-graph does not type-check settings keys, so only MCP-patched graphs pass
    // through zod — a hand-edited or legacy graph can carry `codexFastMode: 'yes'`, which is
    // truthy. `=== true` is what stops that string from silently buying the priority tier.
    await seedStartTask();
    await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        parsedGraph: { ...GRAPH, settings: { codexFastMode: 'yes' } },
      }) as never,
    );
    expect(h.createTask.mock.calls[0][1].triggerContext._config.codexFastMode).toBe(false);
  });

  it('does not gate on model support — resolveCodexCliModel is the single support boundary', async () => {
    // The dispatcher cannot know the execution account type yet (it is resolved later, at claim
    // time), so it forwards intent verbatim; a model with no priority tier degrades in the executor.
    await seedStartTask();
    await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        parsedGraph: {
          ...GRAPH,
          settings: { codexFastMode: true, defaultModel: 'codex-gpt-5.4-mini-medium' },
        },
      }) as never,
    );
    expect(h.createTask.mock.calls[0][1].triggerContext._config.codexFastMode).toBe(true);
  });
});

describe('findLatestCompletedStartTaskRun', () => {
  it('returns the completed start_task, ignoring agent/condition rows', async () => {
    await seedNodeRun('ag1', 'agent', { summary: 's' });
    await seedNodeRun('cond', 'condition', { result: 'continue', passed: true });
    const st = await seedStartTask();

    const row = await findLatestCompletedStartTaskRun(db, flowRunId);
    expect(row?.id).toBe(st.id);
  });

  it('picks the LATEST completed start_task when the node was retried', async () => {
    await seedStartTask({ chatId: 'old' });
    // Later completedAt so desc ordering prefers the retry.
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { ...START_TASK_OUTPUTS, projectId, chatId: 'new' },
      completedAt: new Date(Date.now() + 1000),
    });

    const row = await findLatestCompletedStartTaskRun(db, flowRunId);
    const outputs = (row?.nodeOutput as { outputs: Record<string, unknown> }).outputs;
    expect(outputs.chatId).toBe('new');
  });

  it('returns null when no start_task has completed (only a running one)', async () => {
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      status: 'running',
    });
    expect(await findLatestCompletedStartTaskRun(db, flowRunId)).toBeNull();
  });

  it('keeps sibling Fan Out branches on their own start_task context', async () => {
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    for (const [nodeId, chatId] of [
      ['st-a', 'chat-a'],
      ['st-b', 'chat-b'],
    ] as const) {
      const run = await createNodeRun(db, {
        flowRunId,
        nodeId,
        blockType: 'start_task',
        status: 'running',
        laneIndex: 0,
        parentFanOutNodeRunId: parent.id,
      });
      await setNodeRunStatus(db, run.id, 'completed', {
        nodeOutput: {
          status: 'completed',
          outputs: { ...START_TASK_OUTPUTS, projectId, chatId },
          artifacts: [],
          durationMs: 0,
        },
        completedAt: new Date(),
      });
    }
    const agentRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'ag-a',
      blockType: 'agent',
      status: 'running',
      laneIndex: 0,
      parentFanOutNodeRunId: parent.id,
    });

    const context = await resolveUpstreamStartTaskContext(db, flowRunId, {
      nodeRunId: agentRun.id,
      upstreamNodeIds: ['st-a'],
    });

    expect(context?.chatId).toBe('chat-a');
  });

  it('falls back to the outer start_task for a Fan Out branch root', async () => {
    await seedStartTask();
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fo',
      blockType: 'fan_out',
      status: 'completed',
    });
    const agentRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'ag-fan',
      blockType: 'agent',
      status: 'running',
      laneIndex: 0,
      parentFanOutNodeRunId: parent.id,
    });

    const result = await dispatchAgent(
      agentCtx({
        nodeRunId: agentRun.id,
        node: FAN_OUT_GRAPH.nodes[2],
        parsedGraph: FAN_OUT_GRAPH,
      }) as never,
    );

    expect(result).toMatchObject({ type: 'awaiting_input' });
    expect(h.createTask.mock.calls[0][1].triggerContext.chatId).toBe('chat-1');
  });

  it('keeps traversing through an earlier Fan Out on the same upstream path', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
        { id: 'fo1', blockType: 'fan_out', position: { x: 0, y: 1 } },
        { id: 'a', blockType: 'agent', parentId: 'fo1', position: { x: 0, y: 2 } },
        { id: 'between', blockType: 'agent', position: { x: 0, y: 3 } },
        { id: 'fo2', blockType: 'fan_out', position: { x: 0, y: 4 } },
        { id: 'b', blockType: 'agent', parentId: 'fo2', position: { x: 0, y: 5 } },
      ],
      edges: [
        { id: 'e1', source: 'st', target: 'fo1' },
        { id: 'e2', source: 'fo1', target: 'a' },
        { id: 'e3', source: 'a', target: 'between' },
        { id: 'e4', source: 'between', target: 'fo2' },
        { id: 'e5', source: 'fo2', target: 'b' },
      ],
    };

    expect(findUpstreamNodeIds(graph, 'b')).toContain('st');
  });
});

describe('local multi-agent chain context forwarding', () => {
  it('start_task → agent → agent: agent #2 dispatches with chat ids + plan mode (no crash)', async () => {
    await seedStartTask();

    // previousOutput is the prior agent's output, which carries NO projectId/chatId.
    const res = await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);

    expect(res.type).not.toBe('error');
    expect(h.createTask).toHaveBeenCalledTimes(1);
    const arg = h.createTask.mock.calls[0][1];
    expect(arg.projectId).toBe(projectId);
    expect(arg.triggerContext.chatId).toBe('chat-1');
    expect(arg.triggerContext.subChatId).toBe('sub-1');
    expect(arg.triggerContext._config.executionMode).toBe('continue_chat');
    expect(arg.triggerContext._config.continueChatId).toBe('chat-1');
    expect(arg.triggerContext._config.startMode).toBe('plan');
    // Worktree is inherited from the start_task (not the context-less predecessor) and threaded as a
    // REUSE override under _config — the only place the task-executor reads it. Without reuseWorktree
    // the executor mints a fresh worktree per agent and the flow's work scatters (the bug this guards).
    expect(arg.triggerContext._config.executionOverride).toEqual({
      worktreePath: '/wt/abc',
      branch: 'b',
      baseBranch: 'main',
      reuseWorktree: true,
    });
  });

  it("worktrees-off start_task (worktreePath '') → no executionOverride, startInWorktree: false carried downstream", async () => {
    // '' (not undefined) is what a no-worktree start_task actually emits; task-executor's own
    // resolveWorktreePathForTask is what turns startInWorktree:false into a project-root run.
    await seedStartTask({ worktreePath: '', branch: '', baseBranch: '' });

    const res = await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);

    expect(res.type).not.toBe('error');
    const arg = h.createTask.mock.calls[0][1];
    expect(arg.triggerContext._config.executionOverride).toBeUndefined();
    expect(arg.triggerContext._config.startInWorktree).toBe(false);
  });

  it('start_task → agent → condition → agent: context survives the condition', async () => {
    await seedStartTask();

    // The immediate predecessor is the condition, whose outputs are only {result, passed}.
    const res = await dispatchAgent(agentCtx({ previousOutput: CONDITION_PREV_OUTPUT }) as never);

    expect(res.type).not.toBe('error');
    const arg = h.createTask.mock.calls[0][1];
    expect(arg.projectId).toBe(projectId);
    expect(arg.triggerContext.chatId).toBe('chat-1');
    expect(arg.triggerContext._config.startMode).toBe('plan');
  });

  it('errors clearly when no completed start_task exists upstream', async () => {
    const res = await dispatchAgent(agentCtx({ previousOutput: CONDITION_PREV_OUTPUT }) as never);

    expect(res.type).toBe('error');
    expect((res as { message: string }).message).toContain('no completed upstream start_task');
    expect(h.createTask).not.toHaveBeenCalled();
  });
});

// The chat→task link (chats.taskId) is what makes the sidebar render the task icon + status badge
// for a flow chat — local start_task only creates the chat, so the agent block must link it.
describe('agent block links the chat to its task (sidebar task icon)', () => {
  it('sets chats.taskId on the start_task chat', async () => {
    await createChat(db, { id: 'chat-1', name: 'Flow chat', mode: 'agent' });
    await seedStartTask();

    const res = await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);
    expect(res.type).not.toBe('error');

    const chat = await getChatById(db, 'chat-1');
    expect(chat?.taskId).toBe('task-1');
  });

  it('first agent wins: a later agent does not overwrite the link (guarded null)', async () => {
    await createChat(db, { id: 'chat-1', name: 'Flow chat', mode: 'agent' });
    await seedStartTask();

    await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);
    h.createTask.mockResolvedValue({ id: 'task-2' });
    await dispatchAgent(
      agentCtx({ previousOutput: AGENT_PREV_OUTPUT, nodeRunId: 'ag2b-nr' }) as never,
    );

    const chat = await getChatById(db, 'chat-1');
    expect(chat?.taskId).toBe('task-1');
  });
});

// The flow run's webhook envelope must land on the agent TASK's trigger_context, else
// parseTriggerContext returns null and the Work Queue "View original content" dialog stays hidden
// (the bug). The per-agent fields (_config / chat ids / chain depth) still override the spread.
const WEBHOOK_TRIGGER = {
  _frinkTrigger: 'webhook_trigger',
  source: 'shortcut',
  sourceAccountId: 'integration-uuid',
  integrationId: 'integration-uuid',
  eventType: 'story_update',
  deliveryId: 'd1',
  triggeredBy: { externalUserId: 'm1' },
  timestamp: '2026-06-01T12:00:00.000Z',
  fullContent: { primary_id: 4821, actions: [{ name: 'A story', entity_type: 'story' }] },
};

describe('agent task carries the webhook envelope (View original content)', () => {
  async function dispatchWithInstructions(instructions: string) {
    await seedStartTask();
    const res = await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        triggerContext: WEBHOOK_TRIGGER,
        node: { id: 'ag2', blockType: 'agent', label: 'Build', config: { instructions } },
      }) as never,
    );
    expect(res.type).not.toBe('error');
    return h.createTask.mock.calls[0][1].triggerContext as Record<string, unknown>;
  }

  it('spreads source/eventType/fullContent so the task is a valid TriggerContext', async () => {
    const tc = await dispatchWithInstructions('do it');
    expect(tc.source).toBe('shortcut');
    expect(tc.eventType).toBe('story_update');
    expect(tc.sourceAccountId).toBe('integration-uuid');
    expect(tc.fullContent).toEqual(WEBHOOK_TRIGGER.fullContent);
    expect(tc.triggeredBy).toEqual({ externalUserId: 'm1' });
    // The whole point: the Work Queue gate (parseTriggerContext → isValidTriggerContext) now passes.
    expect(isValidTriggerContext(tc)).toBe(true);
  });

  it('per-agent fields override the spread (chat ids, origin, depth, _config)', async () => {
    const tc = await dispatchWithInstructions('do it');
    expect(tc.chatId).toBe('chat-1');
    expect(tc.subChatId).toBe('sub-1');
    expect(tc._flowOriginId).toBe(flowRunId);
    expect(tc._flowChainDepth).toBe(1);
    expect((tc._config as Record<string, unknown>).executionMode).toBe('continue_chat');
  });

  it('showTriggerCard gates on {{trigger.*}} usage (cloud parity)', async () => {
    const without = await dispatchWithInstructions('do it');
    expect((without._config as Record<string, unknown>).showTriggerCard).toBe(false);

    vi.clearAllMocks();
    h.createTask.mockResolvedValue({ id: 'task-1' });
    const withRef = await dispatchWithInstructions('Handle {{trigger.story.title}}');
    expect((withRef._config as Record<string, unknown>).showTriggerCard).toBe(true);
  });
});

// Per-node mode is sugar over the task startMode channel: config.mode overrides the inherited
// start_task mode for THIS node only (never mutates the shared upstream context). autoApprove sets
// _config.skipReview ONLY when the effective mode is plan, so plan tasks auto-advance instead of
// pausing at plan_ready. Upstream start_task here is plan mode (START_TASK_OUTPUTS.startMode).
describe('agent node per-node mode + autoApprove', () => {
  async function dispatchWithConfig(config: Record<string, unknown>) {
    await seedStartTask();
    const res = await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        node: {
          id: 'ag2',
          blockType: 'agent',
          label: 'Build',
          config: { instructions: 'do it', ...config },
        },
      }) as never,
    );
    expect(res.type).not.toBe('error');
    return h.createTask.mock.calls[0][1].triggerContext._config as {
      startMode?: string;
      skipReview?: boolean;
    };
  }

  it("mode:'agent' overrides the inherited plan mode → startMode execute (override does not leak inherited plan)", async () => {
    const cfg = await dispatchWithConfig({ mode: 'agent' });
    expect(cfg.startMode).toBe('execute');
    expect(cfg.skipReview).toBeUndefined();
  });

  it("mode:'plan' + autoApprove:true → startMode plan + skipReview true (auto-advance, no pause)", async () => {
    const cfg = await dispatchWithConfig({ mode: 'plan', autoApprove: true });
    expect(cfg.startMode).toBe('plan');
    expect(cfg.skipReview).toBe(true);
  });

  it("mode:'plan' without autoApprove → startMode plan, no skipReview (pauses for approval)", async () => {
    const cfg = await dispatchWithConfig({ mode: 'plan' });
    expect(cfg.startMode).toBe('plan');
    expect(cfg.skipReview).toBeUndefined();
  });

  it("mode:'debug' ignores autoApprove → startMode debug, no skipReview (must pause for human repro)", async () => {
    const cfg = await dispatchWithConfig({ mode: 'debug', autoApprove: true });
    expect(cfg.startMode).toBe('debug');
    expect(cfg.skipReview).toBeUndefined();
  });

  it('no mode + autoApprove:true honors the INHERITED plan mode → skipReview true', async () => {
    const cfg = await dispatchWithConfig({ autoApprove: true });
    expect(cfg.startMode).toBe('plan'); // inherited from start_task
    expect(cfg.skipReview).toBe(true);
  });
});

// A deliberate re-dispatch (resume/retry paths) mints a FRESH node_run for a node that already
// ran; the flag tells createChatForTask to set the renderer's alreadySent-dedup bypass, or the
// re-dispatched prompt (already persisted in the reused chat) is swallowed and the run never
// streams. A first dispatch and a heartbeat re-claim (same node_run id) must NOT carry it.
describe('agent node re-dispatch flag (_config.isNodeRedispatch)', () => {
  it('first dispatch of a node → flag absent (other nodes’ runs don’t count)', async () => {
    await seedStartTask();
    await seedNodeRun('ag1', 'agent', { summary: 's' });

    const res = await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);

    expect(res.type).not.toBe('error');
    const cfg = h.createTask.mock.calls[0][1].triggerContext._config as Record<string, unknown>;
    expect(cfg.isNodeRedispatch).toBeUndefined();
  });

  it('re-dispatch (a prior node_run exists for the same node) → flag true', async () => {
    await seedStartTask();
    await createNodeRun(db, { flowRunId, nodeId: 'ag2', blockType: 'agent', status: 'failed' });

    const res = await dispatchAgent(agentCtx({ previousOutput: AGENT_PREV_OUTPUT }) as never);

    expect(res.type).not.toBe('error');
    const cfg = h.createTask.mock.calls[0][1].triggerContext._config as Record<string, unknown>;
    expect(cfg.isNodeRedispatch).toBe(true);
  });

  it('re-claim (the only node_run for the node IS the dispatching one) → flag absent', async () => {
    await seedStartTask();
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'ag2',
      blockType: 'agent',
      status: 'running',
    });

    const res = await dispatchAgent(
      agentCtx({ previousOutput: AGENT_PREV_OUTPUT, nodeRunId: nodeRun.id }) as never,
    );

    expect(res.type).not.toBe('error');
    const cfg = h.createTask.mock.calls[0][1].triggerContext._config as Record<string, unknown>;
    expect(cfg.isNodeRedispatch).toBeUndefined();
  });
});

// Model resolution mirrors cloud net precedence: agent override → upstream start_task model →
// flow settings.defaultModel. All PICKER ids; forwarded verbatim into _config.model (the
// task-executor `shouldForwardTaskModel` gate is the single validation point, tested separately).
// Regression guard: an INHERITED model used to be dropped on the local path → chat ran Sonnet.
describe('agent node inherited model resolution', () => {
  async function dispatchWithModels(opts: {
    agentModel?: string;
    startTaskModel?: string;
    flowDefaultModel?: string;
  }): Promise<string | undefined> {
    await seedStartTask(opts.startTaskModel ? { model: opts.startTaskModel } : {});
    const parsedGraph = opts.flowDefaultModel
      ? { ...GRAPH, settings: { defaultModel: opts.flowDefaultModel } }
      : GRAPH;
    const res = await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        parsedGraph,
        node: {
          id: 'ag2',
          blockType: 'agent',
          label: 'Build',
          config: { instructions: 'do it', ...(opts.agentModel ? { model: opts.agentModel } : {}) },
        },
      }) as never,
    );
    expect(res.type).not.toBe('error');
    return (h.createTask.mock.calls[0][1].triggerContext._config as { model?: string }).model;
  }

  it('EC1: agent override wins over start_task model and flow default', async () => {
    expect(
      await dispatchWithModels({
        agentModel: 'sonnet',
        startTaskModel: 'opus-4.7-max',
        flowDefaultModel: 'opus-4.8',
      }),
    ).toBe('sonnet');
  });

  it('EC2: agent inherits → upstream start_task model wins over flow default', async () => {
    expect(
      await dispatchWithModels({ startTaskModel: 'opus-4.7-max', flowDefaultModel: 'opus-4.8' }),
    ).toBe('opus-4.7-max');
  });

  it('EC3: agent + start_task inherit → flow settings.defaultModel (the reported bug)', async () => {
    expect(await dispatchWithModels({ flowDefaultModel: 'opus-4.8' })).toBe('opus-4.8');
  });

  it('EC4: nothing set anywhere → _config.model key omitted (graceful executor default)', async () => {
    expect(await dispatchWithModels({})).toBeUndefined();
  });

  it('EC4b: empty/whitespace agent override is treated as inherit, not as a set value', async () => {
    expect(await dispatchWithModels({ agentModel: '  ', flowDefaultModel: 'opus-4.8' })).toBe(
      'opus-4.8',
    );
  });

  it('EC8: a non-picker inherited id is forwarded verbatim (the gate, not dispatch, validates it)', async () => {
    // Dispatch does not second-guess the configured value; shouldForwardTaskModel drops
    // raw CLI ids downstream (covered in task-executor.test.ts).
    expect(await dispatchWithModels({ flowDefaultModel: 'claude-opus-4-8' })).toBe(
      'claude-opus-4-8',
    );
  });

  it('EC10: sibling no-leak — an override on one dispatch does not bleed into a later inheriting one', async () => {
    expect(await dispatchWithModels({ agentModel: 'sonnet', flowDefaultModel: 'opus-4.8' })).toBe(
      'sonnet',
    );
    vi.clearAllMocks();
    h.createTask.mockResolvedValue({ id: 'task-1' });
    expect(await dispatchWithModels({ flowDefaultModel: 'opus-4.8' })).toBe('opus-4.8');
  });

  it('EC11: loop-body agent (loopContext set) still inherits the flow default', async () => {
    await seedStartTask();
    const res = await dispatchAgent(
      agentCtx({
        previousOutput: AGENT_PREV_OUTPUT,
        loopContext: { item: 'x', index: 0 },
        parsedGraph: { ...GRAPH, settings: { defaultModel: 'opus-4.8' } },
      }) as never,
    );
    expect(res.type).not.toBe('error');
    expect((h.createTask.mock.calls[0][1].triggerContext._config as { model?: string }).model).toBe(
      'opus-4.8',
    );
  });
});

// sc-3836: st (outer) → fo[st-lane → ag-lane] → ag-after. The continuation's only inputs are the
// lane tails, so findUpstreamNodeIds returns the lane start_task as well as the outer one.
const AFTER_FAN_OUT_GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'fo', blockType: 'fan_out', position: { x: 0, y: 1 } },
    {
      id: 'st-lane',
      blockType: 'start_task',
      parentId: 'fo',
      position: { x: 0, y: 2 },
    },
    {
      id: 'ag-lane',
      blockType: 'agent',
      parentId: 'fo',
      position: { x: 0, y: 3 },
    },
    {
      id: 'ag-after',
      blockType: 'agent',
      position: { x: 0, y: 4 },
      config: { instructions: 'report' },
    },
  ],
  edges: [
    { id: 'e1', source: 'st', target: 'fo' },
    { id: 'e2', source: 'fo', target: 'st-lane' },
    { id: 'e3', source: 'st-lane', target: 'ag-lane' },
    { id: 'e4', source: 'ag-lane', target: 'ag-after' },
  ],
};

describe('nodes after a Fan Out resolve the outer start_task (sc-3836)', () => {
  const t0 = Date.now();

  async function seedLaneStartTasks(count: number) {
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fo',
      blockType: 'fan_out',
      status: 'completed',
    });
    for (let lane = 0; lane < count; lane += 1) {
      // Lanes finish AFTER the outer start_task — the newest completed start_task is a lane's.
      await seedCompletedNodeRun(db, {
        flowRunId,
        nodeId: 'st-lane',
        blockType: 'start_task',
        outputs: {
          ...START_TASK_OUTPUTS,
          projectId,
          chatId: `chat-lane-${lane}`,
          worktreePath: `/wt/lane-${lane}`,
        },
        completedAt: new Date(t0 + 10_000 + lane * 1000),
        laneIndex: lane,
        parentFanOutNodeRunId: parent.id,
      });
    }
    return parent.id;
  }

  async function afterBarrierAgentRun() {
    return createNodeRun(db, {
      flowRunId,
      nodeId: 'ag-after',
      blockType: 'agent',
      status: 'running',
    });
  }

  function dispatchAfterBarrier(nodeRunId: string) {
    return dispatchAgent(
      agentCtx({
        nodeRunId,
        node: AFTER_FAN_OUT_GRAPH.nodes[4],
        parsedGraph: AFTER_FAN_OUT_GRAPH,
        previousOutput: {
          status: 'completed',
          outputs: { results: [], totalCount: 2, _fanOutState: 'completed' },
          artifacts: [],
          durationMs: 0,
        },
      }) as never,
    );
  }

  it('dispatches the continuation agent into the outer chat + worktree, not the last lane', async () => {
    await seedNodeRun(
      'st',
      'start_task',
      {
        ...START_TASK_OUTPUTS,
        projectId,
        chatId: 'chat-outer',
        worktreePath: '/wt/outer',
      },
      new Date(t0),
    );
    await seedLaneStartTasks(4);
    const run = await afterBarrierAgentRun();

    const res = await dispatchAfterBarrier(run.id);

    expect(res.type).not.toBe('error');
    const arg = h.createTask.mock.calls[0][1];
    expect(arg.triggerContext.chatId).toBe('chat-outer');
    expect(arg.triggerContext._config.continueChatId).toBe('chat-outer');
    expect(arg.triggerContext._config.executionOverride.worktreePath).toBe('/wt/outer');
  });

  it('still picks the latest attempt when the outer start_task was retried', async () => {
    await seedNodeRun(
      'st',
      'start_task',
      { ...START_TASK_OUTPUTS, projectId, chatId: 'chat-outer-old' },
      new Date(t0),
    );
    await seedNodeRun(
      'st',
      'start_task',
      { ...START_TASK_OUTPUTS, projectId, chatId: 'chat-outer-new' },
      new Date(t0 + 1000),
    );
    await seedLaneStartTasks(2);
    const run = await afterBarrierAgentRun();

    const context = await resolveUpstreamStartTaskContext(db, flowRunId, {
      nodeRunId: run.id,
      upstreamNodeIds: findUpstreamNodeIds(AFTER_FAN_OUT_GRAPH, 'ag-after'),
    });

    expect(context?.chatId).toBe('chat-outer-new');
  });

  it('refuses to dispatch (no lane chat) when the only start_tasks ran inside lanes', async () => {
    await seedLaneStartTasks(3);
    const run = await afterBarrierAgentRun();

    const res = await dispatchAfterBarrier(run.id);

    expect(res).toMatchObject({ type: 'error' });
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it('ignores a later-completed start_task that is not upstream of the node', async () => {
    // st → cond →(a) ag ; cond →(b) st-other. st-other is not an ancestor of ag.
    const graph: FlowGraph = {
      nodes: [
        { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
        { id: 'cond', blockType: 'condition', position: { x: 0, y: 1 } },
        { id: 'ag', blockType: 'agent', position: { x: 0, y: 2 } },
        { id: 'st-other', blockType: 'start_task', position: { x: 1, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 'st', target: 'cond' },
        { id: 'e2', source: 'cond', target: 'ag' },
        { id: 'e3', source: 'cond', target: 'st-other' },
      ],
    };
    await seedNodeRun(
      'st',
      'start_task',
      { ...START_TASK_OUTPUTS, projectId, chatId: 'chat-mine' },
      new Date(t0),
    );
    await seedNodeRun(
      'st-other',
      'start_task',
      { ...START_TASK_OUTPUTS, projectId, chatId: 'chat-other' },
      new Date(t0 + 5000),
    );
    const run = await createNodeRun(db, {
      flowRunId,
      nodeId: 'ag',
      blockType: 'agent',
      status: 'running',
    });

    const context = await resolveUpstreamStartTaskContext(db, flowRunId, {
      nodeRunId: run.id,
      upstreamNodeIds: findUpstreamNodeIds(graph, 'ag'),
    });

    expect(context?.chatId).toBe('chat-mine');
  });

  it('keeps a lane node on its own lane even when later lanes finished first', async () => {
    await seedNodeRun(
      'st',
      'start_task',
      { ...START_TASK_OUTPUTS, projectId, chatId: 'chat-outer' },
      new Date(t0),
    );
    const parent = await seedLaneStartTasks(3);
    const laneRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'ag-lane',
      blockType: 'agent',
      status: 'running',
      laneIndex: 1,
      parentFanOutNodeRunId: parent,
    });

    const context = await resolveUpstreamStartTaskContext(db, flowRunId, {
      nodeRunId: laneRun.id,
      upstreamNodeIds: findUpstreamNodeIds(AFTER_FAN_OUT_GRAPH, 'ag-lane'),
    });

    expect(context?.chatId).toBe('chat-lane-1');
  });
});
