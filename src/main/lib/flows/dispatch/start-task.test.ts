import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import type { NodeOutput } from '../../../../shared/types/flow';
import type { DispatchResult } from './types';
import { createChat, getChatById, getOrCreateFlowChat } from '../../db/repos/chats';
import { createNodeRun } from '../../db/repos/node-runs';
import { createProject } from '../../db/repos/projects';
import { getSubChatById } from '../../db/repos/sub-chats';
import { seedCompletedNodeRun, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const { h } = vi.hoisted(() => ({
  h: { db: null as unknown, executeShellStep: vi.fn(), createTask: vi.fn() },
}));

vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => h.db,
}));
vi.mock('./shell-step', () => ({ executeShellStep: h.executeShellStep }));
vi.mock('../../db/repos/tasks', async (orig) => ({
  ...(await orig<typeof import('../../db/repos/tasks')>()),
  createTask: h.createTask,
}));

import { dispatchAgent } from './agent';
import { dispatchCondition } from './condition';
import { dispatchStartTask } from './start-task';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'ag', blockType: 'agent', position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 'st', target: 'ag' }],
};

const WORKTREE_OUTPUT = {
  status: 'completed' as const,
  outputs: { worktreePath: '/wt/abc', branch: 'b', baseBranch: 'main', configured: true },
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
  h.executeShellStep.mockResolvedValue(WORKTREE_OUTPUT);
  h.createTask.mockResolvedValue({ id: 'task-1' });

  ({ projectId, flowRunId } = await seedFlowRun(db, GRAPH));
});

// dispatchStartTask alone does NOT persist a node_run (the engine's advanceFlowRun
// does). dispatchAgent resolves its context from the upstream start_task node_run, so
// the handoff tests must seed that row — mirror what advanceFlowRun writes.
function persistStartTaskRun(output: unknown) {
  return seedCompletedNodeRun(db, {
    flowRunId,
    nodeId: 'st',
    blockType: 'start_task',
    nodeOutput: output,
  });
}

function startTaskCtx(over: Record<string, unknown> = {}) {
  return {
    flowRunId,
    nodeRunId: 'st-nr',
    userId: 'u1',
    node: {
      id: 'st',
      blockType: 'start_task',
      label: 'Spawn worktree',
      config: { projectId, startMode: 'plan', startInWorktree: true },
    },
    previousOutput: undefined,
    triggerContext: null,
    loopContext: undefined,
    // Real ctx always carries the parsed graph (advance.ts) — the projectId
    // resolver reads settings.defaultProjectId from it. Override per-case.
    parsedGraph: GRAPH,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('start_task runtime project routing', () => {
  it('routes the worktree, chat row and outputs to a project named by the trigger', async () => {
    const devkit = await createProject(db, { name: 'devkit', path: '/repos/devkit' });
    const res = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          config: { projectId: '{{trigger.project}}', startInWorktree: true },
        },
        triggerContext: { project: 'devkit' },
      }),
    );

    const outputs = outputsOf(res);
    expect(outputs.projectId).toBe(devkit.id);
    expect(h.executeShellStep.mock.calls[0][0].projectId).toBe(devkit.id);
    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.projectId).toBe(devkit.id);
  });

  it('hands the runtime-resolved project down to the agent that follows it', async () => {
    const devkit = await createProject(db, { name: 'devkit', path: '/repos/devkit' });
    const routed = {
      node: { id: 'st', blockType: 'start_task', config: { projectId: '{{trigger.project}}' } },
      triggerContext: { project: 'devkit' },
    };
    const st = await dispatchStartTask(ctxFor(routed));
    await persistStartTaskRun(outputOf(st));

    // SAFETY: the literal below supplies every DispatchContext field this dispatcher reads.
    await dispatchAgent({
      flowRunId,
      nodeRunId: 'ag-nr-routed',
      userId: 'u1',
      node: { id: 'ag', blockType: 'agent', label: 'Work it', config: { instructions: 'go' } },
      previousOutput: outputOf(st),
      triggerContext: null,
      loopContext: undefined,
      parsedGraph: GRAPH,
      signal: new AbortController().signal,
    } as never);

    expect(h.createTask.mock.calls[0][1].projectId).toBe(devkit.id);
    expect(h.createTask.mock.calls[0][1].projectId).not.toBe(projectId);
  });

  it('fails the node rather than falling back to the flow default when the template resolves to nothing', async () => {
    const res = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', config: { projectId: '{{trigger.project}}' } },
        triggerContext: { project: '' },
        parsedGraph: { ...GRAPH, settings: { defaultProjectId: projectId } },
      }),
    );

    const message = 'start_task projectId template "{{trigger.project}}" resolved to nothing';
    expect(res).toEqual({ type: 'error', message });
    expect(h.executeShellStep).not.toHaveBeenCalled();
  });
});

// SAFETY: startTaskCtx supplies every DispatchContext field these dispatchers read; the cast only
// bridges the test's FlowGraph literal to the parsed-graph type.
const ctxFor = (...args: Parameters<typeof startTaskCtx>) => startTaskCtx(...args) as never;

// SAFETY: every caller asserts the dispatch completed first, and `completed` carries `output`.
const outputOf = (res: DispatchResult): NodeOutput => (res as { output: NodeOutput }).output;

const outputsOf = (res: DispatchResult): NodeOutput['outputs'] => outputOf(res).outputs;

describe('local start_task → agent handoff', () => {
  it('start_task surfaces projectId/chatId/subChatId + startMode and creates the chat', async () => {
    const res = await dispatchStartTask(startTaskCtx() as never);

    expect(res.type).toBe('completed');
    const outputs = outputsOf(res);
    expect(outputs.projectId).toBe(projectId);
    expect(outputs.startMode).toBe('plan');
    expect(typeof outputs.chatId).toBe('string');
    expect(typeof outputs.subChatId).toBe('string');

    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.projectId).toBe(projectId);
    expect(chat?.worktreePath).toBe('/wt/abc');
    expect(chat?.taskId).toBeNull(); // local leaves task_id NULL (task-executor links at runtime)
    const subChat = await getSubChatById(db, outputs.subChatId as string);
    expect(subChat?.chatId).toBe(outputs.chatId);
  });

  it('completes inline without provisioning a worktree when startInWorktree is unset', async () => {
    const res = await dispatchStartTask(
      ctxFor({ node: { id: 'st', blockType: 'start_task', config: { projectId } } }),
    );

    expect(res.type).toBe('completed');
    expect(h.executeShellStep).not.toHaveBeenCalled();
    const outputs = outputsOf(res);
    expect(outputs.worktreePath).toBe('');
    expect(outputs.configured).toBe(true);

    // An empty worktreePath must persist as null, not '' — downstream `??` readers would prefer
    // '' over their fallback. SAFETY: start_task always writes chatId as a string.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.worktreePath).toBeNull();
  });

  it('a retry of a no-worktree start_task reuses its prior chat instead of orphaning one', async () => {
    // getOrCreateFlowChat's reuse lookup is worktree-keyed and finds nothing here, so a retry
    // must resolve the earlier chat through the completed node_run instead.
    const first = await dispatchStartTask(
      ctxFor({ node: { id: 'st', blockType: 'start_task', config: { projectId } } }),
    );
    const firstOutputs = outputsOf(first);
    await persistStartTaskRun(outputOf(first));

    const retry = await dispatchStartTask(
      ctxFor({ node: { id: 'st', blockType: 'start_task', config: { projectId } } }),
    );
    const retryOutputs = outputsOf(retry);

    expect(retryOutputs.chatId).toBe(firstOutputs.chatId);
    expect(retryOutputs.subChatId).toBe(firstOutputs.subChatId);
  });

  it("does not reuse a sibling fan-out lane's chat for a no-worktree start_task", async () => {
    // Lane 0's start_task already completed with its own chat.
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { projectId, chatId: 'chat-lane-0', subChatId: 'sub-lane-0', worktreePath: '' },
      laneIndex: 0,
      parentFanOutNodeRunId: 'fo-nr',
    });
    // Lane 1's own row, as the engine would insert before dispatching it.
    const laneOneRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      status: 'running',
      laneIndex: 1,
      parentFanOutNodeRunId: 'fo-nr',
    });

    const res = await dispatchStartTask(
      ctxFor({
        nodeRunId: laneOneRun.id,
        node: { id: 'st', blockType: 'start_task', config: { projectId } },
      }),
    );

    expect(outputsOf(res).chatId).not.toBe('chat-lane-0');
  });

  it('does not provision a worktree from a Branch from value alone — startInWorktree must be explicit', async () => {
    // Batch chaining bypasses this field entirely (client always uses injected baseBranches);
    // its guideline's own examples always pair `branch` with `startInWorktree: true`.
    const res = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', config: { projectId, branch: 'release-1' } },
      }),
    );

    expect(res.type).toBe('completed');
    expect(h.executeShellStep).not.toHaveBeenCalled();
    expect(outputsOf(res).worktreePath).toBe('');
  });

  it("treats a non-boolean startInWorktree as off, matching cloud's strict === true check", async () => {
    // A hand-edited flow graph is untyped JSON — "true" (string) is a real input shape, not a
    // hypothetical. Locks in parity with the cloud dispatcher's identical strict check.
    const res = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          config: { projectId, startInWorktree: 'true' },
        },
      }),
    );

    expect(res.type).toBe('completed');
    expect(h.executeShellStep).not.toHaveBeenCalled();
    expect(outputsOf(res).worktreePath).toBe('');
  });

  it('names the chat from the Task title (config.label), not the Display name (node.label)', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          label: 'Spawn worktree', // Display name — must NOT be used as the chat name
          config: { projectId, label: 'Evaluate Shortcut story' },
        },
      }),
    );
    const outputs = outputsOf(st);
    expect(outputs.label).toBe('Evaluate Shortcut story');

    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.name).toBe('Evaluate Shortcut story');
    const subChat = await getSubChatById(db, outputs.subChatId as string);
    expect(subChat?.name).toBe('Evaluate Shortcut story');
  });

  it('renders {{…}} templates in the Task title', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          label: 'St',
          config: { projectId, label: 'Story: {{trigger.title}}' },
        },
        triggerContext: { title: 'Fix login' },
      }),
    );
    const outputs = outputsOf(st);
    expect(outputs.label).toBe('Story: Fix login');
    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.name).toBe('Story: Fix login');
  });

  it('defaults to "Flow: Start Task" when the Task title is empty', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', label: 'Spawn worktree', config: { projectId } },
      }),
    );
    const outputs = outputsOf(st);
    expect(outputs.label).toBe('Flow: Start Task');
    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.name).toBe('Flow: Start Task');
  });

  it('defaults when the Task title template resolves to an empty value (no blank chat name)', async () => {
    // A referenced trigger field exists but is empty (e.g. webhook with a blank title) —
    // renders to '' and must fall through to the default, not name the chat ''.
    const st = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          label: 'St',
          config: { projectId, label: '{{trigger.title}}' },
        },
        triggerContext: { title: '' },
      }),
    );
    const outputs = outputsOf(st);
    expect(outputs.label).toBe('Flow: Start Task');
    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.name).toBe('Flow: Start Task');
  });

  it('defaults gracefully when the Task title is a non-string (malformed config)', async () => {
    // config is an unchecked cast from the flow graph JSON; an API/hand-edited graph can
    // carry a non-string label. Must not crash or blank the chat name.
    const st = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          label: 'St',
          config: { projectId, label: 12345 },
        },
      }),
    );
    expect(st.type).toBe('completed');
    const outputs = outputsOf(st);
    expect(outputs.label).toBe('Flow: Start Task');
    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.name).toBe('Flow: Start Task');
  });

  it('agent names its task row from the upstream start_task Task title (stc.label)', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          label: 'Spawn worktree',
          config: { projectId, label: 'Evaluate Shortcut story' },
        },
      }),
    );
    await persistStartTaskRun(outputOf(st));
    await dispatchAgent({
      flowRunId,
      nodeRunId: 'ag-nr-title',
      userId: 'u1',
      node: { id: 'ag', blockType: 'agent', label: 'Evaluate', config: { instructions: 'do it' } },
      previousOutput: outputOf(st),
      triggerContext: null,
      loopContext: undefined,
      parsedGraph: GRAPH,
      signal: new AbortController().signal,
    } as never);
    // Task title comes from the start_task's Task title — NOT the agent node's label ('Evaluate').
    expect(h.createTask.mock.calls[0][1].title).toBe('Evaluate Shortcut story');
  });

  it('runs on the flow default project when the node has no projectId of its own', async () => {
    // A Start Task node can leave its project blank and inherit the flow's default
    // project. The editor shows that default as the node's effective project, so the
    // run must use it too — and surface the resolved id, since the downstream agent
    // reads its project from this node's output.
    const st = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', label: 'St', config: { startMode: 'plan' } },
        parsedGraph: { ...GRAPH, settings: { defaultProjectId: projectId } },
      }),
    );
    expect(st.type).toBe('completed');
    const outputs = outputsOf(st);
    expect(outputs.projectId).toBe(projectId);
    // SAFETY: start_task always writes chatId as a string into its outputs.
    const chat = await getChatById(db, outputs.chatId as string);
    expect(chat?.projectId).toBe(projectId);
  });

  it("prefers the node's own project over a differing flow default", async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', label: 'St', config: { projectId } },
        parsedGraph: { ...GRAPH, settings: { defaultProjectId: 'some-other-project' } },
      }),
    );
    const outputs = outputsOf(st);
    expect(outputs.projectId).toBe(projectId);
  });

  it('fails with a message naming the flow default when no project is set anywhere', async () => {
    const res = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', label: 'St', config: { startMode: 'plan' } },
        parsedGraph: { ...GRAPH, settings: {} },
      }),
    );
    expect(res.type).toBe('error');
    expect((res as { message: string }).message).toContain('flow default project');
  });

  it('hands the flow-default project down to the agent block', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', label: 'St', config: {} },
        parsedGraph: { ...GRAPH, settings: { defaultProjectId: projectId } },
      }),
    );
    await persistStartTaskRun(outputOf(st));
    const agRes = await dispatchAgent({
      flowRunId,
      nodeRunId: 'ag-nr-default',
      userId: 'u1',
      node: { id: 'ag', blockType: 'agent', label: 'A', config: { instructions: 'x' } },
      previousOutput: outputOf(st),
      triggerContext: null,
      loopContext: undefined,
      parsedGraph: GRAPH,
      signal: new AbortController().signal,
    } as never);
    expect(agRes.type).not.toBe('error');
    expect(h.createTask.mock.calls[0][1].projectId).toBe(projectId);
  });

  it('is idempotent per worktree — a retry reuses the same chat (no orphans)', async () => {
    const first = await dispatchStartTask(startTaskCtx() as never);
    const second = await dispatchStartTask(startTaskCtx() as never);
    const out1 = (first as { output: { outputs: Record<string, unknown> } }).output.outputs;
    const out2 = (second as { output: { outputs: Record<string, unknown> } }).output.outputs;

    expect(out2.chatId).toBe(out1.chatId);
    expect(out2.subChatId).toBe(out1.subChatId);
  });

  it('agent accepts the handoff: creates a task carrying the chat ids + plan startMode', async () => {
    const st = await dispatchStartTask(startTaskCtx() as never);
    const prevOutput = outputOf(st);
    await persistStartTaskRun(prevOutput);

    const agRes = await dispatchAgent({
      flowRunId,
      nodeRunId: 'ag-nr',
      userId: 'u1',
      node: { id: 'ag', blockType: 'agent', label: 'Evaluate', config: { instructions: 'do it' } },
      previousOutput: prevOutput,
      triggerContext: null,
      loopContext: undefined,
      parsedGraph: GRAPH,
      signal: new AbortController().signal,
    } as never);

    // Not an error — the missing-projectId crash is gone.
    expect(agRes.type).not.toBe('error');
    expect(h.createTask).toHaveBeenCalledTimes(1);
    const arg = h.createTask.mock.calls[0][1];
    const outputs = outputsOf(st);
    expect(arg.projectId).toBe(projectId);
    expect(arg.triggerContext.chatId).toBe(outputs.chatId);
    expect(arg.triggerContext.subChatId).toBe(outputs.subChatId);
    expect(arg.triggerContext._config.startMode).toBe('plan');
    // The executor only adopts the start_task chat via continue_chat; assert the
    // producer→consumer contract so the chat isn't orphaned.
    expect(arg.triggerContext._config.executionMode).toBe('continue_chat');
    expect(arg.triggerContext._config.continueChatId).toBe(outputs.chatId);
  });

  it('omits startMode from _config when start_task has none', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: { id: 'st', blockType: 'start_task', label: 'St', config: { projectId } },
      }),
    );
    await persistStartTaskRun(outputOf(st));
    await dispatchAgent({
      flowRunId,
      nodeRunId: 'ag-nr-2',
      userId: 'u1',
      node: { id: 'ag', blockType: 'agent', label: 'A', config: { instructions: 'x' } },
      previousOutput: outputOf(st),
      triggerContext: null,
      loopContext: undefined,
      parsedGraph: GRAPH,
      signal: new AbortController().signal,
    } as never);
    const arg = h.createTask.mock.calls[0][1];
    expect(arg.triggerContext._config.startMode).toBeUndefined();
  });

  it('surfaces config.model (picker id) in start_task outputs', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          label: 'St',
          config: { projectId, model: 'opus-4.7-max' },
        },
      }),
    );
    const outputs = outputsOf(st);
    expect(outputs.model).toBe('opus-4.7-max');
  });

  it('agent inherits the start_task model end-to-end (producer → consumer)', async () => {
    const st = await dispatchStartTask(
      ctxFor({
        node: {
          id: 'st',
          blockType: 'start_task',
          label: 'St',
          config: { projectId, model: 'opus-4.7-max' },
        },
      }),
    );
    await persistStartTaskRun(outputOf(st));
    await dispatchAgent({
      flowRunId,
      nodeRunId: 'ag-nr-3',
      userId: 'u1',
      node: { id: 'ag', blockType: 'agent', label: 'A', config: { instructions: 'x' } },
      previousOutput: outputOf(st),
      triggerContext: null,
      loopContext: undefined,
      parsedGraph: GRAPH,
      signal: new AbortController().signal,
    } as never);
    const arg = h.createTask.mock.calls[0][1];
    expect(arg.triggerContext._config.model).toBe('opus-4.7-max');
  });
});

describe('getOrCreateFlowChat — reuse branch', () => {
  it('creates a sub-chat when the reused worktree-chat has none', async () => {
    // A chat can exist for a worktree without a sub-chat (e.g. created elsewhere
    // than getOrCreateFlowChat). The reuse path must still yield a usable
    // subChatId for the downstream agent, not return an empty one.
    const chat = await createChat(db, {
      projectId,
      name: 'lonely',
      mode: 'agent',
      worktreePath: '/wt/lonely',
    });

    const res = await getOrCreateFlowChat(db, {
      projectId,
      name: 'reuse',
      worktreePath: '/wt/lonely',
    });

    expect(res.chatId).toBe(chat.id); // reused the existing chat
    expect(typeof res.subChatId).toBe('string');
    expect(res.subChatId.length).toBeGreaterThan(0);
    const sub = await getSubChatById(db, res.subChatId);
    expect(sub?.chatId).toBe(chat.id);
  });
});

// sc-2706: a branch selects where the worktree forks from, so an authored branch that does not
// resolve must stop the node — but only when a worktree is actually cut, since branch is unused otherwise.
/** What graph JSON can hold in a branch field: a template, a hand-edited number, or a cleared field. */
type PersistedBranch = string | number | null;

describe('start_task branch resolution at dispatch', () => {
  function withBranch(
    branch: PersistedBranch,
    startInWorktree: boolean,
    outputs: Record<string, string> = {},
  ) {
    return ctxFor({
      node: {
        id: 'st',
        blockType: 'start_task',
        label: 'Spawn worktree',
        config: { projectId, branch, startInWorktree },
      },
      previousOutput: { status: 'completed', outputs, artifacts: [], durationMs: 0 },
    });
  }

  it('errors naming the node and template when the branch does not resolve', async () => {
    const res = await dispatchStartTask(withBranch('feat/{{previous.ticket}}', true));

    expect(res).toEqual({
      type: 'error',
      message:
        'start_task "Spawn worktree": branch template "feat/{{previous.ticket}}" did not resolve',
    });
    expect(h.executeShellStep).not.toHaveBeenCalled();
  });

  it('hands the resolved branch to the worktree step', async () => {
    const res = await dispatchStartTask(
      withBranch('feat/{{previous.ticket}}', true, { ticket: 'sc-2706' }),
    );

    expect(res.type).toBe('completed');
    expect(h.executeShellStep.mock.calls[0][0].branch).toBe('feat/sc-2706');
  });

  it('ignores an unresolvable branch when no worktree is cut, since nothing reads it', async () => {
    const res = await dispatchStartTask(withBranch('feat/{{previous.ticket}}', false));

    expect(res.type).toBe('completed');
    expect(h.executeShellStep).not.toHaveBeenCalled();
  });

  it('errors on a non-string branch persisted in graph JSON rather than throwing', async () => {
    const res = await dispatchStartTask(withBranch(42, true));

    expect(res).toEqual({
      type: 'error',
      message: 'start_task "Spawn worktree": branch must be text',
    });
  });

  it('treats an absent (null) branch field as unset, since the editor removes a cleared field', async () => {
    const res = await dispatchStartTask(withBranch(null, true));

    expect(res.type).toBe('completed');
    expect(h.executeShellStep.mock.calls[0][0].branch).toBeUndefined();
  });

  it('fails on an authored blank branch rather than forking from the default branch', async () => {
    const res = await dispatchStartTask(withBranch('   ', true));

    expect(res).toEqual({
      type: 'error',
      message: 'start_task "Spawn worktree": branch template "   " resolved to nothing',
    });
    expect(h.executeShellStep).not.toHaveBeenCalled();
  });
});
