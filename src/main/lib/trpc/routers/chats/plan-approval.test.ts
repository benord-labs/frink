import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../../shared/types';

const { rows, safeParseMessagesMock, whereMock } = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    chatId: string | null;
    mode: string;
    messages: string;
  }>,
  safeParseMessagesMock: vi.fn((_id: string, messages: string) => JSON.parse(messages)),
  whereMock: vi.fn(),
}));

vi.mock('../../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        where: whereMock,
      }),
    }),
  }),
}));
vi.mock('../../../db/repos/sub-chats', () => ({
  safeParseMessages: safeParseMessagesMock,
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
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0;
    whereMock.mockImplementation(async () => rows);
    safeParseMessagesMock.mockImplementation((_id: string, messages: string) =>
      JSON.parse(messages),
    );
  });

  it('returns no approvals without a non-empty selector', async () => {
    await expect(caller().getPendingPlanApprovals({})).resolves.toEqual([]);
    await expect(caller().getPendingPlanApprovals({ chatIds: [] })).resolves.toEqual([]);
    expect(whereMock).not.toHaveBeenCalled();
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

  it('deduplicates parent-chat selectors into one query', async () => {
    rows.push({ id: 'sub-1', chatId: 'chat-1', mode: 'plan', messages: planMessage('plan-1') });

    await expect(
      caller().getPendingPlanApprovals({ chatIds: ['chat-1', 'chat-1'] }),
    ).resolves.toEqual([{ subChatId: 'sub-1', chatId: 'chat-1' }]);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('skips non-Plan rows before parsing their message histories', async () => {
    rows.push(
      { id: 'sub-agent', chatId: 'chat-1', mode: 'agent', messages: planMessage('old-plan') },
      { id: 'sub-plan', chatId: 'chat-1', mode: 'plan', messages: planMessage('new-plan') },
    );

    await expect(caller().getPendingPlanApprovals({ chatIds: ['chat-1'] })).resolves.toEqual([
      { subChatId: 'sub-plan', chatId: 'chat-1' },
    ]);
    expect(safeParseMessagesMock).toHaveBeenCalledTimes(1);
    expect(safeParseMessagesMock).toHaveBeenCalledWith('sub-plan', expect.any(String));
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

  it('skips malformed histories and rows without a parent chat id', async () => {
    rows.push(
      { id: 'broken', chatId: 'chat-1', mode: 'plan', messages: 'not-json' },
      { id: 'orphan', chatId: null, mode: 'plan', messages: planMessage('plan-1') },
    );

    await expect(caller().getPendingPlanApprovals({ chatIds: ['chat-1'] })).resolves.toEqual([]);
  });
});
