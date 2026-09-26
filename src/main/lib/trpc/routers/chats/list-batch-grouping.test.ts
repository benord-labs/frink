/**
 * End-to-end wiring guard for sidebar batch grouping. Unlike `list.test.ts` (which mocks the
 * repos), this drives the REAL listRouter — real repos, real freshDb, and crucially the real
 * caseConvertOutput middleware — to pin the contract the original regression broke:
 *
 *   `listBatchGroups()[i].batch_id` (snake, via publicProcedureRaw) MUST equal
 *   `listByFolder().chats[j].batchId` (camel, via publicProcedure) for the SAME chat,
 *
 * because the renderer keys its group map on `group.batch_id` and matches it against
 * `chat.batchId`. When caseConvert was added to publicProcedure, listBatchGroups' `batch_id`
 * silently camelCased to `batchId` → the map key went undefined → every batch un-grouped. A
 * unit test with mocked repos cannot see that; this can. See decision `flows-ipc-casing-contract`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChat } from '../../../db/repos/chats';
import { getOrCreateFlowRunByIdempotencyKey } from '../../../db/repos/flow-runs';
import { createFlowVersion } from '../../../db/repos/flow-versions';
import { createFlow } from '../../../db/repos/flows';
import { seedCompletedNodeRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as TestDb | null } }));
vi.mock('../../../db', () => ({ getDatabase: () => dbHolder.db }));

import { listRouter } from './list';

const caller = () => listRouter.createCaller({ getWindow: () => null });
const BATCH_ID = '11111111-1111-4111-8111-111111111111';

describe('sidebar batch grouping — end-to-end casing/wiring contract', () => {
  let chatId: string;

  beforeEach(async () => {
    const db = freshDb();
    dbHolder.db = db;
    const flow = await createFlow(db, { name: 'Triage' });
    const version = await createFlowVersion(db, {
      flowId: flow.id,
      graph: { nodes: [], edges: [] },
    });
    const chat = await createChat(db, { name: 'agent run', projectId: null });
    chatId = chat.id;
    const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: version.id,
      status: 'running',
      triggerContext: null,
      idempotencyKey: null,
      batchId: BATCH_ID,
      startedAt: new Date(),
    });
    await seedCompletedNodeRun(db, {
      flowRunId: run.id,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });
  });

  it('listBatchGroups (snake batch_id) and listByFolder (camel batchId) agree on the key', async () => {
    const groups = await caller().listBatchGroups();
    const folder = await caller().listByFolder({ projectIds: null, limit: 30 });

    // The group key the renderer reads must survive un-camelCased (publicProcedureRaw)...
    expect(groups).toHaveLength(1);
    expect(groups[0].batch_id).toBe(BATCH_ID);
    // ...and the chat's batchId must be the SAME value (else batchGroups.has(chat.batchId) is false).
    const chat = folder.chats.find((c) => c.id === chatId);
    expect(chat?.batchId).toBe(BATCH_ID);
    expect(groups[0].batch_id).toBe(chat?.batchId);
  });

  it('listByBatch returns the batch chat for the expand-on-demand row', async () => {
    const rows = await caller().listByBatch({ batchId: BATCH_ID });
    expect(rows.map((r) => r.id)).toEqual([chatId]);
    expect(rows[0].batchId).toBe(BATCH_ID);
  });
});
