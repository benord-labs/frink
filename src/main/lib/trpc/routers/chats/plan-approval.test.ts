import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../../shared/types';
import * as schema from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db')>()),
  getDatabase: () => state.db,
}));

import { planApprovalRouter } from './stats/plan-approval';

const caller = () => planApprovalRouter.createCaller({ getWindow: () => null });
const planMessage = (planId: string, status = 'awaiting_approval') =>
  JSON.stringify([
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool-frink-plan',
          input: { planId, summary: 'Plan', status },
        },
      ],
    },
  ]);

describe('planApprovalRouter.getPendingPlanApprovals', () => {
  let db: TestDb;
  const rows = {
    push: (...subs: Array<{ id: string; chatId: string; mode: string; messages: string }>) => {
      for (const sub of subs) {
        db.insert(schema.chats).values({ id: sub.chatId }).onConflictDoNothing().run();
        db.insert(schema.subChats).values(sub).run();
      }
    },
  };

  beforeEach(() => {
    db = freshDb();
    state.db = db;
  });

  it('returns no approvals without a non-empty selector', async () => {
    await expect(caller().getPendingPlanApprovals({})).resolves.toEqual([]);
    await expect(caller().getPendingPlanApprovals({ chatIds: [] })).resolves.toEqual([]);
  });

  it('accepts parent chat selectors and returns every pending child agent', async () => {
    rows.push(
      { id: 'sub-1', chatId: 'chat-1', mode: 'plan', messages: planMessage('plan-1') },
      { id: 'sub-2', chatId: 'chat-1', mode: 'plan', messages: planMessage('plan-2') },
    );

    await expect(caller().getPendingPlanApprovals({ chatIds: ['chat-1'] })).resolves.toEqual([
      { subChatId: 'sub-1', chatId: 'chat-1' },
      { subChatId: 'sub-2', chatId: 'chat-1' },
    ]);
  });

  it('deduplicates parent-chat selectors', async () => {
    rows.push({ id: 'sub-1', chatId: 'chat-1', mode: 'plan', messages: planMessage('plan-1') });

    await expect(
      caller().getPendingPlanApprovals({ chatIds: ['chat-1', 'chat-1'] }),
    ).resolves.toEqual([{ subChatId: 'sub-1', chatId: 'chat-1' }]);
  });

  it('ignores sub-chats that are not in Plan mode', async () => {
    rows.push(
      { id: 'sub-agent', chatId: 'chat-1', mode: 'agent', messages: planMessage('old-plan') },
      { id: 'sub-plan', chatId: 'chat-1', mode: 'plan', messages: planMessage('new-plan') },
    );

    await expect(caller().getPendingPlanApprovals({ chatIds: ['chat-1'] })).resolves.toEqual([
      { subChatId: 'sub-plan', chatId: 'chat-1' },
    ]);
  });

  it('does not resurrect a plan from a closed approval epoch', async () => {
    rows.push({
      id: 'sub-1',
      chatId: 'chat-1',
      mode: 'plan',
      messages: JSON.stringify([
        ...JSON.parse(planMessage('old-plan')),
        {
          role: 'user',
          parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
        },
        { role: 'user', parts: [{ type: 'text', text: 'Plan the follow-up.' }] },
      ]),
    });

    await expect(caller().getPendingPlanApprovals({ chatIds: ['chat-1'] })).resolves.toEqual([]);
  });

  it('skips a malformed history', async () => {
    rows.push({ id: 'broken', chatId: 'chat-1', mode: 'plan', messages: 'not-json' });

    await expect(caller().getPendingPlanApprovals({ chatIds: ['chat-1'] })).resolves.toEqual([]);
  });
});
