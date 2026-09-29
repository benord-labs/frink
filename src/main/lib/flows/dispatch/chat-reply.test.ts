import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import { isHtmlArtifactPart } from '../../../../shared/lib/artifacts/html-artifact';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { createChat } from '../../db/repos/chats';
import { createNodeRun } from '../../db/repos/node-runs';
import { createSubChat, getSubChatById } from '../../db/repos/sub-chats';
import { seedCompletedNodeRun, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import type { Dispatcher } from './types';

const { h } = vi.hoisted(() => ({
  h: { db: null as unknown, subChatReadError: null as Error | null },
}));

vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => h.db,
}));
// Everything stays real except the one read we need to fail on demand — a blanket module mock
// would also stub createSubChat, which these tests use to build real fixtures.
vi.mock('../../db/repos/sub-chats', async (orig) => {
  const actual = await orig<typeof import('../../db/repos/sub-chats')>();
  return {
    ...actual,
    getSubChatById: async (...args: Parameters<typeof actual.getSubChatById>) => {
      if (h.subChatReadError) throw h.subChatReadError;
      return actual.getSubChatById(...args);
    },
  };
});
// chat_reply broadcasts to renderer windows — no Electron in tests.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const captureContainedMock = vi.fn();
vi.mock('../../sentry', () => ({
  captureContained: (...args: unknown[]) => captureContainedMock(...args),
}));

import { dispatchChatReply } from './chat-reply';

// start_task → agent → condition → chat_reply — the condition drops chatId, so the
// immediate-predecessor read errored "chat_reply requires chatId".
const GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'ag', blockType: 'agent', position: { x: 0, y: 1 } },
    { id: 'cond', blockType: 'condition', position: { x: 0, y: 2 } },
    { id: 'cr', blockType: 'chat_reply', position: { x: 0, y: 3 } },
  ],
  edges: [
    { id: 'e1', source: 'st', target: 'ag' },
    { id: 'e2', source: 'ag', target: 'cond' },
    { id: 'e3', source: 'cond', target: 'cr' },
  ],
};

const CONDITION_PREV = {
  status: 'completed' as const,
  outputs: { result: 'continue', passed: true },
  artifacts: [],
  durationMs: 0,
};

const CUSTOM_NODE_PREV = {
  status: 'completed' as const,
  outputs: { message: 'hello world', locationName: 'Riberalta' },
  artifacts: [],
  durationMs: 0,
};

let db: TestDb;
let projectId: string;
let flowRunId: string;
type ChatReplyContext = Parameters<Dispatcher>[0];

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  h.db = db;
  h.subChatReadError = null;

  ({ projectId, flowRunId } = await seedFlowRun(db, GRAPH));
});

async function makeChat() {
  const chat = await createChat(db, { projectId, name: 'C', mode: 'agent', worktreePath: null });
  const sub = await createSubChat(db, {
    chatId: chat.id,
    name: 'C',
    mode: 'agent',
    messages: '[]',
  });
  return { chatId: chat.id, subChatId: sub.id };
}

function seedStartTask(outputs: Record<string, unknown>) {
  return seedCompletedNodeRun(db, {
    flowRunId,
    nodeId: 'st',
    blockType: 'start_task',
    outputs: { projectId, ...outputs },
  });
}

function crCtx(over: Partial<ChatReplyContext> = {}): ChatReplyContext {
  return {
    flowRunId,
    nodeRunId: 'cr-nr',
    node: {
      id: 'cr',
      blockType: 'chat_reply',
      label: 'Reply',
      config: { messageTemplate: 'done' },
    },
    previousOutput: CONDITION_PREV,
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: GRAPH,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('chat_reply upstream chat resolution', () => {
  it('resolves chatId/subChatId from the upstream start_task past a condition', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });

    const res = await dispatchChatReply(crCtx());

    expect(res.type).toBe('completed');
    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.chatId).toBe(chatId);
    expect(outputs.subChatId).toBe(subChatId);
    expect(outputs.delivered).toBe(true);
  });

  it('trigger chatId/subChatId win over a different upstream start_task (EC5)', async () => {
    const upstream = await makeChat();
    await seedStartTask({ chatId: upstream.chatId, subChatId: upstream.subChatId });
    const trigger = await makeChat();

    const res = await dispatchChatReply(
      crCtx({ triggerContext: { chatId: trigger.chatId, subChatId: trigger.subChatId } }),
    );

    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.chatId).toBe(trigger.chatId);
    expect(outputs.subChatId).toBe(trigger.subChatId);
  });

  it('falls back to the newest sub-chat when only chatId resolves (EC7)', async () => {
    const { chatId, subChatId } = await makeChat();
    // start_task surfaced chatId but no subChatId; no trigger / no predecessor sub.
    await seedStartTask({ chatId });

    const res = await dispatchChatReply(crCtx());

    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.chatId).toBe(chatId);
    expect(outputs.subChatId).toBe(subChatId); // the only (newest) sub-chat
  });

  it('errors when no chat can be resolved (no start_task, no trigger)', async () => {
    const res = await dispatchChatReply(crCtx());

    expect(res.type).toBe('error');
    expect((res as { message: string }).message).toContain('requires chatId');
  });
});

// sc-3836: st → fo[st-lane → ag-lane] → cr. The continuation's inputs are the lane tails.
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
    { id: 'cr', blockType: 'chat_reply', position: { x: 0, y: 4 } },
  ],
  edges: [
    { id: 'e1', source: 'st', target: 'fo' },
    { id: 'e2', source: 'fo', target: 'st-lane' },
    { id: 'e3', source: 'st-lane', target: 'ag-lane' },
    { id: 'e4', source: 'ag-lane', target: 'cr' },
  ],
};

describe('chat_reply after a Fan Out (sc-3836)', () => {
  it('lands in the outer start_task chat, not the last lane that finished', async () => {
    const outer = await makeChat();
    await seedStartTask({ chatId: outer.chatId, subChatId: outer.subChatId });
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fo',
      blockType: 'fan_out',
      status: 'completed',
    });
    for (let lane = 0; lane < 3; lane += 1) {
      const laneChat = await makeChat();
      await seedCompletedNodeRun(db, {
        flowRunId,
        nodeId: 'st-lane',
        blockType: 'start_task',
        outputs: { projectId, ...laneChat },
        completedAt: new Date(Date.now() + 10_000 + lane * 1000),
        laneIndex: lane,
        parentFanOutNodeRunId: parent.id,
      });
    }
    const crRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'cr',
      blockType: 'chat_reply',
      status: 'running',
    });

    const res = await dispatchChatReply(
      crCtx({
        nodeRunId: crRun.id,
        parsedGraph: AFTER_FAN_OUT_GRAPH,
        // What advance.ts hands the continuation: the Fan Out aggregate, no chatId.
        previousOutput: {
          status: 'completed',
          outputs: { results: [], totalCount: 3, _fanOutState: 'completed' },
          artifacts: [],
          durationMs: 0,
        },
      }),
    );

    expect(res.type).toBe('completed');
    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.chatId).toBe(outer.chatId);
    expect(outputs.subChatId).toBe(outer.subChatId);
  });
});

describe('chat_reply template rendering (sc-1501)', () => {
  it('resolves {{previous.<field>}} from the immediate predecessor outputs, flat', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });

    const res = await dispatchChatReply(
      crCtx({
        node: {
          id: 'cr',
          blockType: 'chat_reply',
          label: 'Reply',
          config: { messageTemplate: '{{previous.message}} ({{previous.locationName}})' },
        },
        previousOutput: CUSTOM_NODE_PREV,
      }),
    );

    expect(res.type).toBe('completed');
    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.message).toBe('hello world (Riberalta)');
  });
});

const whenArtifactsEnabled = LAUNCH_FLAGS.flowHtmlArtifacts ? describe : describe.skip;

describe('chat_reply interactive view availability', () => {
  it('delivers or refuses an interactive reply in step with the launch flag', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });

    const res = await dispatchChatReply(
      crCtx({
        node: {
          id: 'cr',
          blockType: 'chat_reply',
          label: 'Reply',
          config: {
            contentType: 'html_artifact',
            artifactTitleTemplate: 'Report',
            artifactBodyHtmlTemplate: '<button>go</button>',
          },
        },
        previousOutput: CUSTOM_NODE_PREV,
      }),
    );
    const delivered = (await getSubChatById(db, subChatId))?.messages ?? [];

    if (LAUNCH_FLAGS.flowHtmlArtifacts) {
      expect(res.type).toBe('completed');
      expect(delivered).toHaveLength(1);
    } else {
      expect(res).toMatchObject({ type: 'error', message: expect.stringContaining('turned off') });
      expect(delivered).toHaveLength(0);
    }
  });

  it('delivers an ordinary text reply either way', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });

    const res = await dispatchChatReply(crCtx());

    expect(res.type).toBe('completed');
    expect((await getSubChatById(db, subChatId))?.messages).toHaveLength(1);
  });
});

whenArtifactsEnabled('chat_reply interactive views', () => {
  it('persists one inert versioned artifact part and deduplicates a logical delivery retry', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });
    const ctx = crCtx({
      node: {
        id: 'cr',
        blockType: 'chat_reply',
        label: 'Reply',
        config: {
          contentType: 'html_artifact',
          artifactTitleTemplate: 'Report {{previous.locationName}}',
          artifactBodyHtmlTemplate: '<button>{{previous.message}}</button>',
        },
      },
      previousOutput: CUSTOM_NODE_PREV,
    });

    const [first, retry] = await Promise.all([
      dispatchChatReply(ctx),
      dispatchChatReply({ ...ctx, nodeRunId: 'cr-retry-nr' }),
    ]);

    expect(first.type).toBe('completed');
    expect(retry.type).toBe('completed');
    const subChat = await getSubChatById(db, subChatId);
    expect(subChat?.messages).toHaveLength(1);
    expect(subChat?.messages[0]?.parts).toEqual([
      {
        type: 'data-html-artifact',
        data: {
          version: 1,
          artifactId: `${flowRunId}:cr`,
          title: 'Report Riberalta',
          bodyHtml: '<button>hello world</button>',
        },
      },
    ]);
    expect(subChat?.messages[0]?.metadata).toMatchObject({
      source: 'chat_reply',
      flowRunId,
      nodeRunId: expect.stringMatching(/^cr(?:-retry)?-nr$/),
    });
  });

  it('keeps sequential fan-out artifacts distinct while deduplicating an item retry', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });
    const ctx = crCtx({
      node: {
        id: 'cr',
        blockType: 'chat_reply',
        label: 'Reply',
        config: {
          contentType: 'html_artifact',
          artifactTitleTemplate: 'Report {{loop.currentIndex}}',
          artifactBodyHtmlTemplate: '<p>{{loop.currentItem}}</p>',
        },
      },
    });
    const loopContext = (currentIndex: number) => ({
      currentItem: `item-${currentIndex}`,
      currentIndex,
      totalCount: 2,
    });

    await dispatchChatReply({ ...ctx, loopContext: loopContext(0) });
    await dispatchChatReply({ ...ctx, loopContext: loopContext(1) });
    await dispatchChatReply({ ...ctx, loopContext: loopContext(1) });

    const subChat = await getSubChatById(db, subChatId);
    expect(subChat?.messages).toHaveLength(2);
    expect(
      subChat?.messages.map((message) => message.parts.find(isHtmlArtifactPart)?.data.artifactId),
    ).toEqual([`${flowRunId}:cr:loop:0`, `${flowRunId}:cr:loop:1`]);
  });

  it('stops repeated substitutions as soon as the rendered body exceeds the byte limit', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });
    const toJSON = vi.fn(() => 'x'.repeat(40_000));

    const result = await dispatchChatReply(
      crCtx({
        node: {
          id: 'cr',
          blockType: 'chat_reply',
          label: 'Reply',
          config: {
            contentType: 'html_artifact',
            artifactTitleTemplate: 'Report',
            artifactBodyHtmlTemplate: '{{previous.large}}'.repeat(1_000),
          },
        },
        previousOutput: { ...CUSTOM_NODE_PREV, outputs: { large: { toJSON } } },
      }),
    );

    expect(result).toMatchObject({ type: 'error', message: expect.stringMatching(/65,536 bytes/) });
    expect(toJSON).toHaveBeenCalledTimes(2);
    expect((await getSubChatById(db, subChatId))?.messages).toEqual([]);
  });

  it('rejects rendered artifact body HTML over the UTF-8 limit before persistence', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });

    const result = await dispatchChatReply(
      crCtx({
        node: {
          id: 'cr',
          blockType: 'chat_reply',
          label: 'Reply',
          config: {
            contentType: 'html_artifact',
            artifactTitleTemplate: 'Report',
            artifactBodyHtmlTemplate: '😀'.repeat(16_385),
          },
        },
      }),
    );

    expect(result).toMatchObject({ type: 'error', message: expect.stringMatching(/65,536 bytes/) });
    expect((await getSubChatById(db, subChatId))?.messages).toEqual([]);
  });

  it('validates the trimmed title by code points rather than pre-trim UTF-8 bytes', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });
    const title = '🎉'.repeat(120);

    const result = await dispatchChatReply(
      crCtx({
        node: {
          id: 'cr',
          blockType: 'chat_reply',
          label: 'Reply',
          config: {
            contentType: 'html_artifact',
            artifactTitleTemplate: '{{previous.title}}{{previous.newline}}',
            artifactBodyHtmlTemplate: '<p>ok</p>',
          },
        },
        previousOutput: { ...CUSTOM_NODE_PREV, outputs: { title, newline: '\n' } },
      }),
    );

    expect(result.type).toBe('completed');
    const subChat = await getSubChatById(db, subChatId);
    expect(subChat?.messages[0]?.parts.find(isHtmlArtifactPart)?.data.title).toBe(title);
  });
});

/**
 * Inside the flow engine a read failure CONTAINS as a node error — a throw here terminalizes
 * nothing useful. It must stay distinguishable from an absent row so the run's failure reason is
 * honest. See docs/decisions/sub-chat-read-failure-posture.md.
 */
describe('chat_reply sub-chat read failure vs absent row', () => {
  it('reports a read failure as its own error rather than as a missing sub-chat', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });
    h.subChatReadError = new Error('SQLITE_IOERR: disk I/O error');

    const res = await dispatchChatReply(crCtx());

    expect(res.type).toBe('error');
    const { message } = res as { message: string };
    expect(message).toContain('could not read sub_chat');
    // The absent-row wording would misattribute an infrastructure fault to a deleted chat.
    expect(message).not.toContain('not found in chat');
    // Contained faults are reported, or they are invisible in production.
    expect(captureContainedMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'flow-chat-reply',
      stage: 'sub-chat-read',
    });
  });

  // The read-failure branch sits directly above the ownership check, so this pins that inserting
  // it did not let a mismatched sub-chat through. A flow must never post its reply into a chat
  // the resolved sub-chat does not belong to.
  it('refuses a sub-chat that belongs to a different chat', async () => {
    const owner = await makeChat();
    const other = await makeChat();

    const res = await dispatchChatReply(
      crCtx({
        triggerContext: { chatId: other.chatId, subChatId: owner.subChatId },
      }),
    );

    expect(res.type).toBe('error');
    expect((res as { message: string }).message).toContain('not found in chat');
  });

  it('still reports a genuinely absent sub-chat as not found', async () => {
    const { chatId } = await makeChat();
    // resolveChatRefs trusts an explicitly supplied subChatId without checking it exists,
    // so this reaches the read and comes back null — the real absent-row path.
    const res = await dispatchChatReply(
      crCtx({ triggerContext: { chatId, subChatId: 'sub-that-never-existed' } }),
    );

    expect(res.type).toBe('error');
    const { message } = res as { message: string };
    expect(message).toContain('not found in chat');
    expect(message).not.toContain('could not read sub_chat');
  });
});

// sc-2706: a chat_reply posting literal placeholder text was the original sc-1501 P0 symptom.
describe('chat_reply never posts an unresolved placeholder', () => {
  it('renders an absent key as empty in the message it posts', async () => {
    const { chatId, subChatId } = await makeChat();
    await seedStartTask({ chatId, subChatId });

    const res = await dispatchChatReply(
      crCtx({
        node: {
          id: 'cr',
          blockType: 'chat_reply',
          label: 'Reply',
          config: { messageTemplate: 'Result: {{previous.missing}}.' },
        },
      }),
    );

    expect(res.type).toBe('completed');
    const posted = JSON.stringify(res);
    expect(posted).not.toContain('{{previous.');
    expect(posted).toContain('Result: .');
  });
});
