import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { seedCompletedNodeRun, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const { h } = vi.hoisted(() => ({ h: { db: null as unknown, executeShellStep: vi.fn() } }));

vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => h.db,
}));
vi.mock('./shell-step', () => ({ executeShellStep: h.executeShellStep }));

import { dispatchRunCommand } from './run-command';

// start_task → condition → run_command — the condition drops worktreePath, so the
// immediate-predecessor read crashed run_command with 'no triggerWorktreePath provided'.
const GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'cond', blockType: 'condition', position: { x: 0, y: 1 } },
    { id: 'rc', blockType: 'run_command', position: { x: 0, y: 2 } },
  ],
  edges: [
    { id: 'e1', source: 'st', target: 'cond' },
    { id: 'e2', source: 'cond', target: 'rc' },
  ],
};

const SHELL_OUTPUT = {
  status: 'completed' as const,
  outputs: { stdout: 'ok' },
  artifacts: [],
  durationMs: 0,
};
// The condition's output carries no worktreePath — the whole point of sc-802.
const CONDITION_PREV = {
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
  h.executeShellStep.mockResolvedValue(SHELL_OUTPUT);

  ({ projectId, flowRunId } = await seedFlowRun(db, GRAPH));
});

function seedStartTask(worktreePath: string | null) {
  return seedCompletedNodeRun(db, {
    flowRunId,
    nodeId: 'st',
    blockType: 'start_task',
    outputs: { projectId, chatId: 'c', subChatId: 's', ...(worktreePath ? { worktreePath } : {}) },
  });
}

// opts.projectId: omit the node's own projectId by passing null (to exercise the
// flow-default fallback); opts.settings: attach a flow default to the graph.
function rcCtx(
  config: Record<string, unknown>,
  opts: { projectId?: string | null; settings?: Record<string, unknown> } = {},
) {
  const nodeProjectId = opts.projectId === undefined ? projectId : opts.projectId;
  return {
    flowRunId,
    nodeRunId: 'rc-nr',
    userId: 'u1',
    node: {
      id: 'rc',
      blockType: 'run_command',
      label: 'Run',
      config: {
        ...(nodeProjectId ? { projectId: nodeProjectId } : {}),
        command: 'echo hi',
        ...config,
      },
    },
    previousOutput: CONDITION_PREV,
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: opts.settings ? { ...GRAPH, settings: opts.settings } : GRAPH,
    signal: new AbortController().signal,
  };
}

describe('run_command runtime project routing', () => {
  it('renders the node projectId so an upstream node can pick the target project', async () => {
    // SAFETY: the literal below supplies every DispatchContext field this dispatcher reads.
    const res = await dispatchRunCommand({
      ...rcCtx({}, { projectId: '{{previous.project}}' }),
      previousOutput: { ...CONDITION_PREV, outputs: { project: projectId } },
    } as never);

    expect(res.type).toBe('completed');
    expect(h.executeShellStep.mock.calls[0][0].projectId).toBe(projectId);
  });
});

describe('run_command upstream worktree resolution', () => {
  it('resolves triggerWorktreePath from the upstream start_task past a condition', async () => {
    await seedStartTask('/wt/abc');

    const res = await dispatchRunCommand(rcCtx({ workingDirectory: 'trigger_worktree' }) as never);

    expect(res.type).toBe('completed');
    expect(h.executeShellStep).toHaveBeenCalledTimes(1);
    expect(h.executeShellStep.mock.calls[0][0].triggerWorktreePath).toBe('/wt/abc');
  });

  it('passes through an empty worktreePath when the upstream start_task ran without one', async () => {
    // '' is what a no-worktree start_task actually outputs (seedStartTask's own falsy check
    // can't express this — it must be seeded directly).
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { projectId, chatId: 'c', subChatId: 's', worktreePath: '' },
    });

    // SAFETY: rcCtx supplies every DispatchContext field this dispatcher reads; the cast only
    // bridges the test fixture's loose object literal to the strict context type.
    const res = await dispatchRunCommand(rcCtx({ workingDirectory: 'trigger_worktree' }) as never);

    expect(res.type).toBe('completed');
    expect(h.executeShellStep.mock.calls[0][0].triggerWorktreePath).toBe('');
  });

  it('does not resolve a worktree for workingDirectory project_root', async () => {
    await seedStartTask('/wt/abc');

    await dispatchRunCommand(rcCtx({ workingDirectory: 'project_root' }) as never);

    expect(h.executeShellStep.mock.calls[0][0].triggerWorktreePath).toBeUndefined();
  });
});

describe('run_command project resolution', () => {
  it('runs on the flow default project when the node has no project of its own', async () => {
    const res = await dispatchRunCommand(
      rcCtx({}, { projectId: null, settings: { defaultProjectId: projectId } }) as never,
    );
    expect(res.type).toBe('completed');
    expect(h.executeShellStep.mock.calls[0][0].projectId).toBe(projectId);
  });

  it('fails with a message naming the flow default when no project is set anywhere', async () => {
    const res = await dispatchRunCommand(rcCtx({}, { projectId: null, settings: {} }) as never);
    expect(res.type).toBe('error');
    expect((res as { message: string }).message).toContain('flow default project');
  });
});

// sc-2706: a shell command is an executable sink, so an unresolved placeholder must stop the node.
// Rendering it empty turns `rm -rf /tmp/work/{{previous.dir}}` into `rm -rf /tmp/work/`.
describe('run_command fails closed on an unresolved placeholder', () => {
  it('refuses to run a command whose placeholder names a missing key', async () => {
    const res = await dispatchRunCommand(
      // SAFETY: rcCtx supplies every DispatchContext field this dispatcher reads.
      rcCtx({ command: 'rm -rf /tmp/work/{{previous.dir}}' }) as never,
    );

    expect(res.type).toBe('error');
    // SAFETY: asserted above that res.type === 'error', the variant carrying `message`.
    expect((res as { message: string }).message).toContain('{{previous.dir}}');
    expect(h.executeShellStep).not.toHaveBeenCalled();
  });

  it('still runs a command whose placeholders all resolve, including to an empty value', async () => {
    // SAFETY: rcCtx supplies every DispatchContext field this dispatcher reads; the override only
    // swaps in outputs where `result` is present but empty.
    const res = await dispatchRunCommand({
      ...rcCtx({ command: 'echo {{previous.result}} {{previous.passed}}' }),
      previousOutput: { ...CONDITION_PREV, outputs: { result: '', passed: true } },
    } as never);

    expect(res.type).toBe('completed');
    expect(h.executeShellStep).toHaveBeenCalledTimes(1);
  });
});

describe('run_command guard edge shapes', () => {
  it('runs a command whose value is too large to render, keeping the literal per contract', async () => {
    // SAFETY: rcCtx supplies every DispatchContext field this dispatcher reads; the override only
    // swaps in outputs holding an oversize value.
    const res = await dispatchRunCommand({
      ...rcCtx({ command: 'echo {{previous.big}}' }),
      previousOutput: { ...CONDITION_PREV, outputs: { big: 'x'.repeat(50_001) } },
    } as never);

    expect(res.type).toBe('completed');
  });

  it('handles a non-string command from unchecked graph JSON without throwing', async () => {
    const persisted: string = JSON.parse('123');

    // SAFETY: rcCtx supplies every DispatchContext field this dispatcher reads.
    const res = await dispatchRunCommand(rcCtx({ command: persisted }) as never);

    expect(res.type).toBe('completed');
  });
});

describe('run_command in an uncertain shell context', () => {
  it('runs a command whose missing placeholder sits where it is never substituted', async () => {
    const res = await dispatchRunCommand(
      // SAFETY: rcCtx supplies every DispatchContext field this dispatcher reads.
      rcCtx({ command: `echo "$(printf '{{previous.missing}}')"` }) as never,
    );

    expect(res.type).toBe('completed');
    expect(h.executeShellStep).toHaveBeenCalledTimes(1);
  });
});
