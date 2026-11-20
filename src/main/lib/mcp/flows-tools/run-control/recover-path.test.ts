import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { chats, flowRuns, nodeRuns, subChatMessages, subChats, tasks } from '../../../db/schema';
import { seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  hasActiveFlowAdmission: vi.fn(async () => false),
}));

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db')>()),
  getDatabase: () => mocks.db,
}));
vi.mock('../../../mobile/domain/context', () => ({ executionReady: () => true }));
vi.mock('../../../flows/admission/runtime', () => ({
  hasActiveFlowAdmission: mocks.hasActiveFlowAdmission,
  registerParkedFlowResumeDispatcher: vi.fn(),
}));

import { setFlowAdmissionLifecycleHooks } from '../../../flows/admission/activity';
import * as parkedResume from '../../../flows/admission/terminal-resume/parked-resume';
import { handleContinueRun } from './index';

const requestParkedFlowResume = vi
  .spyOn(parkedResume, 'requestParkedFlowResume')
  .mockResolvedValue({ state: 'queued', created: true } as never);

let db: TestDb;
let runId: string;

/** A paused run whose step hit a usage limit and has since given its slot up. */
beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  mocks.db = db;
  const graph = { nodes: [{ id: 'agent', blockType: 'agent', config: {} }], edges: [] };
  ({ flowRunId: runId } = await seedFlowRun(db, graph));
  await db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, runId));
  await db.insert(chats).values({ id: 'chat-1', name: 'Flow chat' });
  await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'session-1' });
  await db.insert(nodeRuns).values({ id: 'nr-1', flowRunId: runId, nodeId: 'agent', blockType: 'agent' });
  await db.insert(tasks).values({
    id: 'task-1',
    description: 'Ship the PR',
    source: 'flow',
    status: 'needs_attention',
    flowRunId: runId,
    nodeRunId: 'nr-1',
    sourceId: 'nr-1',
    result: { subChatId: 'sub-1', usageLimit: true },
  });
  const prompt = { id: 'u1', role: 'user', parts: [], metadata: { dispatchTaskId: 'task-1' } };
  await db.insert(subChatMessages).values([
    { subChatId: 'sub-1', seq: 0, message: JSON.stringify(prompt) },
    { subChatId: 'sub-1', seq: 1, message: JSON.stringify({ id: 'a1', role: 'assistant', parts: [] }) },
  ]);
  setFlowAdmissionLifecycleHooks({
    reconcile: vi.fn(async () => {}),
    reconcileTicket: vi.fn(async () => {}),
    requestRelease: vi.fn(async () => {}),
  });
});

it("reaches the Work Queue's real Carry on, which queues a slot-released run to take a slot back", async () => {
  const result = await handleContinueRun({ runId, nodeRunId: 'nr-1' }, {});
  expect(result.isError).toBe(false);
  expect(requestParkedFlowResume).toHaveBeenCalledWith({
    flowRunId: runId,
    nodeRunId: 'nr-1',
    kind: 'continue',
  });
  expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({ outcome: 'queued' });
}, 60_000);
