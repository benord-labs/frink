import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../shared/types/plan';
import { mobileRequestSchema } from '../../../../shared/types/remote/mobile';

const fixture = vi.hoisted(() => ({
  requireChat: vi.fn(),
  history: vi.fn(),
  send: vi.fn(),
  activity: vi.fn(),
}));
vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  requireChat: fixture.requireChat,
  mobileCallers: { chats: { getSubChatMessages: fixture.history } },
}));
vi.mock('./chat', () => ({ sendMobileMessage: fixture.send, subChatActivity: fixture.activity }));
import { approveMobilePlan } from './plan';

const request = {
  type: 'approvePlan' as const,
  chatId: 'chat',
  subChatId: 'sub',
  planId: 'plan-1',
  requestId: '6f1c1d4e-8b7a-4c2f-9d3e-2a1b0c9d8e7f',
};
const planMessage = (planId: string) => ({
  id: planId,
  role: 'assistant',
  parts: [
    {
      type: 'tool-frink-plan',
      input: { planId, status: 'awaiting_approval', planText: '## Retry webhooks' },
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.requireChat.mockResolvedValue({
    chat: { id: 'chat', taskId: null },
    subChat: { id: 'sub', mode: 'plan' },
  });
  fixture.history.mockResolvedValue({ messages: [planMessage('plan-1')], hasMore: false });
  fixture.activity.mockReturnValue('idle');
  fixture.send.mockResolvedValue({ ok: true });
});

describe('approving a plan from the phone', () => {
  it('sends desktop’s approval message in Agent mode with the plan the turn implements', async () => {
    expect(mobileRequestSchema.parse(request)).toEqual(request);
    await expect(approveMobilePlan(request)).resolves.toEqual({ ok: true });
    expect(fixture.send).toHaveBeenCalledWith(
      { ...request, text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT },
      { mode: 'agent', approvedPlanContext: { planId: 'plan-1', planText: '## Retry webhooks' } },
    );
  });

  it('refuses a plan that was replaced, already decided, or is still being written', async () => {
    fixture.history.mockResolvedValueOnce({ messages: [planMessage('plan-2')], hasMore: false });
    await expect(approveMobilePlan(request)).rejects.toMatchObject({ status: 409 });
    fixture.requireChat.mockResolvedValueOnce({
      chat: { id: 'chat', taskId: null },
      subChat: { id: 'sub', mode: 'agent' },
    });
    await expect(approveMobilePlan(request)).rejects.toMatchObject({ status: 409 });
    fixture.activity.mockReturnValueOnce('running');
    await expect(approveMobilePlan(request)).rejects.toMatchObject({ status: 409 });
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
