import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { seedCompletedNodeRun, seedFlowRun } from '../../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createChat, linkChatToTask } from '../chats';
import { createTask, updateTaskStatus } from '../tasks';
import { listSidebarActiveChats } from './sidebar-active-chats';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', config: { instructions: 'go' }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
};

describe('listSidebarActiveChats', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const taskFor = (chatId: string) =>
    createTask(db, { description: 'task', source: 'manual', result: { chatId } });

  it('places chats linked to an unfinished task by task_id or by result.chatId', async () => {
    const byLink = await createChat(db, { name: 'linked' });
    const byResult = await createChat(db, { name: 'result' });
    const linkedTask = await createTask(db, {
      description: 'task',
      source: 'manual',
    });
    await linkChatToTask(db, byLink.id, linkedTask.id);
    await taskFor(byResult.id);

    const rows = await listSidebarActiveChats(db);
    expect(rows.map((row) => row.chatId).sort()).toEqual([byLink.id, byResult.id].sort());
    expect(rows[0]).toMatchObject({ projectId: null, batchId: null, hasLiveFlowRun: false });
  });

  it('leaves out finished tasks and archived or unknown chats', async () => {
    const finished = await createChat(db, { name: 'finished' });
    const archived = await createChat(db, { name: 'archived', archivedAt: new Date() });
    await updateTaskStatus(db, (await taskFor(finished.id)).id, 'completed');
    await taskFor(archived.id);
    await taskFor('not-a-local-chat');

    expect(await listSidebarActiveChats(db)).toEqual([]);
  });

  it('flags a chat driven only by a live flow run', async () => {
    const chat = await createChat(db, { name: 'flow' });
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await seedCompletedNodeRun(db, {
      flowRunId,
      nodeId: 'st',
      blockType: 'start_task',
      outputs: { chatId: chat.id },
    });

    expect(await listSidebarActiveChats(db)).toEqual([
      { chatId: chat.id, projectId: null, batchId: null, hasLiveFlowRun: true },
    ]);
  });
});
