import { beforeEach, describe, expect, it } from 'vitest';
import type { TriggerStartMode } from '../../../../shared/types/trigger-context';
import { getOrCreateFlowRunByIdempotencyKey } from '../../db/repos/flow-runs';
import { chats, nodeRuns, subChats, tasks } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { resolveSessionResumeSeed } from './session-resume';

let db: TestDb;
let flowRunId: string;
let otherFlowRunId: string;

const CHAT_ID = 'chat-1';
const NODE_ID = 'agent-node';
const NODE_RUN_ID = 'nr-1';

const GRAPH = { nodes: [{ id: NODE_ID, blockType: 'agent' }], edges: [] };

beforeEach(async () => {
  db = freshDb();
  const seeded = await seedFlowRun(db, GRAPH);
  flowRunId = seeded.flowRunId;
  const { run: otherRun } = await getOrCreateFlowRunByIdempotencyKey(db, {
    flowVersionId: seeded.versionId,
    status: 'running',
    triggerContext: null,
    idempotencyKey: 'k2',
    startedAt: new Date(),
  });
  otherFlowRunId = otherRun.id;
  await db.insert(chats).values({ id: CHAT_ID, name: 'flow chat' });
});

async function seedSubChat(over: Partial<typeof subChats.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? 'sub-1';
  await db.insert(subChats).values({
    id,
    chatId: CHAT_ID,
    mode: 'agent',
    sessionId: 'sess-1',
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...over,
  });
  return id;
}

async function seedNodeRun(id: string, nodeId: string): Promise<void> {
  await db.insert(nodeRuns).values({ id, flowRunId, nodeId, blockType: 'agent' });
}

async function seedFlowTask(over: Partial<typeof tasks.$inferInsert> = {}): Promise<void> {
  await db.insert(tasks).values({
    id: over.id ?? 'task-1',
    description: 'flow task',
    source: 'flow',
    status: 'cancelled',
    flowRunId,
    sourceId: NODE_RUN_ID,
    result: { subChatId: 'sub-1' },
    ...over,
  });
}

function resolve(configuredStartMode: TriggerStartMode | undefined = 'plan') {
  return resolveSessionResumeSeed(db, {
    chatId: CHAT_ID,
    flowRunId,
    nodeId: NODE_ID,
    configuredStartMode,
  });
}

describe('resolveSessionResumeSeed — session gate', () => {
  it("seeds when the chat's sub-chat has a session and its newest flow task is this node", async () => {
    await seedSubChat();
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();

    const seed = await resolve();
    expect(seed?.config.resumeSession).toBe(true);
    expect(seed?.config.resumeSubChatId).toBe('sub-1');
  });

  it('returns null when the chat has no sub-chats', async () => {
    expect(await resolve()).toBeNull();
  });

  it("returns null when the chat's sub-chat has no sessionId", async () => {
    await seedSubChat({ sessionId: null });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    expect(await resolve()).toBeNull();
  });

  it("returns null when the sub-chat's newest flow task was minted for a DIFFERENT node", async () => {
    await seedSubChat();
    await seedNodeRun(NODE_RUN_ID, 'some-other-node');
    await seedFlowTask();
    expect(await resolve()).toBeNull();
  });

  it('returns null when the newest flow task belongs to a different run', async () => {
    await seedSubChat();
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask({ flowRunId: otherFlowRunId });
    expect(await resolve()).toBeNull();
  });

  it('returns null when the newest flow task never streamed (no result.subChatId)', async () => {
    await seedSubChat();
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask({ result: null });
    expect(await resolve()).toBeNull();
  });
});

describe('resolveSessionResumeSeed — mode clamp (plan→non-plan forward only)', () => {
  it('configured plan + live agent → seeds startMode execute', async () => {
    await seedSubChat({ mode: 'agent' });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    expect((await resolve('plan'))?.config.resumeStartMode).toBe('execute');
  });

  it('configured plan + live debug → seeds startMode debug', async () => {
    await seedSubChat({ mode: 'debug' });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    expect((await resolve('plan'))?.config.resumeStartMode).toBe('debug');
  });

  it('configured plan + live plan → no override (keeps configured)', async () => {
    await seedSubChat({ mode: 'plan' });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    expect((await resolve('plan'))?.config.resumeStartMode).toBeUndefined();
  });

  it('configured execute + live plan → NARROWS to plan with explicit skipReview (a resumed turn must not reopen a plan session with write permissions; explicit skipReview keeps completion at the configured semantics)', async () => {
    await seedSubChat({ mode: 'plan' });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    const seed = await resolve('execute');
    expect(seed?.config.resumeSession).toBe(true);
    expect(seed?.config.resumeStartMode).toBe('plan');
    expect(seed?.config.skipReview).toBe(true);
  });

  it('UNSET configured mode + live plan → narrows too (the executor default would otherwise flip the plan session to write-enabled)', async () => {
    await seedSubChat({ mode: 'plan' });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    // Direct call: the resolve() helper's default parameter would replace `undefined`.
    const seed = await resolveSessionResumeSeed(db, {
      chatId: CHAT_ID,
      flowRunId,
      nodeId: NODE_ID,
      configuredStartMode: undefined,
    });
    expect(seed?.config.resumeStartMode).toBe('plan');
    expect(seed?.config.skipReview).toBe(true);
  });

  it('forward clamp does not stamp skipReview (derived true is already correct)', async () => {
    await seedSubChat({ mode: 'agent' });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    const seed = await resolve('plan');
    expect(seed?.config.resumeStartMode).toBe('execute');
    expect(seed?.config.skipReview).toBeUndefined();
  });

  it('unmapped live mode text → no override (safe lookup falls back to configured)', async () => {
    await seedSubChat({ mode: 'weird-mode' });
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask();
    expect((await resolve('plan'))?.config.resumeStartMode).toBeUndefined();
  });
});

describe('resolveSessionResumeSeed — prior error', () => {
  async function seedWithError(result: unknown): Promise<void> {
    await seedSubChat();
    await seedNodeRun(NODE_RUN_ID, NODE_ID);
    await seedFlowTask({ result: result as never });
  }

  it('carries a string result.error into resumePriorError', async () => {
    await seedWithError({ subChatId: 'sub-1', error: 'boom' });
    expect((await resolve())?.config.resumePriorError).toBe('boom');
  });

  it('reads an {error: {message}} shape', async () => {
    await seedWithError({ subChatId: 'sub-1', error: { message: 'nested boom' } });
    expect((await resolve())?.config.resumePriorError).toBe('nested boom');
  });

  it('truncates to 200 chars', async () => {
    await seedWithError({ subChatId: 'sub-1', error: 'x'.repeat(500) });
    expect((await resolve())?.config.resumePriorError).toHaveLength(200);
  });

  it('omits resumePriorError when the result has no error', async () => {
    await seedWithError({ subChatId: 'sub-1' });
    expect((await resolve())?.config.resumePriorError).toBeUndefined();
  });
});
