import { describe, expect, it, vi } from 'vitest';
import { openWorkQueueTaskChat, startWorkQueuePlanExecution } from './work-queue-chat-actions';

const reviewedMessages = [
  {
    role: 'assistant',
    parts: [
      {
        type: 'tool-frink-plan',
        input: {
          planId: 'plan-1',
          summary: 'Implement the reviewed plan',
          planText: '## Plan\nImplement the reviewed plan',
          status: 'awaiting_approval',
        },
      },
    ],
  },
];

function actions(overrides: Record<string, unknown> = {}) {
  return {
    ownsNavigation: vi.fn(() => true),
    getChat: vi.fn(async () => ({ id: 'chat-1', subChats: [{ id: 'sub-1' }] })),
    getSubChat: vi.fn(async () => ({ id: 'sub-1', messages: [] })),
    seedUserMessageIfEmpty: vi.fn(async () => ({ seeded: true })),
    navigate: vi.fn(() => true),
    isNotFoundError: vi.fn(() => false),
    onMissingChat: vi.fn(),
    onUnknownChat: vi.fn(),
    ...overrides,
  };
}

describe('openWorkQueueTaskChat', () => {
  it('does not let a stale caller seed after a fresh owner remounts', async () => {
    let resolveStale!: (chat: unknown) => void;
    let staleOwns = true;
    const stale = actions({
      ownsNavigation: () => staleOwns,
      getChat: () => new Promise((resolve) => (resolveStale = resolve)),
    });
    const staleOpen = openWorkQueueTaskChat(
      { taskId: 'task-1', prompt: 'prompt', chatId: 'chat-1' },
      stale,
    );
    staleOwns = false;
    const fresh = actions();

    await openWorkQueueTaskChat({ taskId: 'task-1', prompt: 'prompt', chatId: 'chat-1' }, fresh);
    resolveStale({ id: 'chat-1', subChats: [{ id: 'sub-1' }] });
    await staleOpen;

    expect(fresh.seedUserMessageIfEmpty).toHaveBeenCalledTimes(1);
    expect(stale.seedUserMessageIfEmpty).not.toHaveBeenCalled();
    expect(fresh.navigate).toHaveBeenCalledWith('chat-1', 'sub-1');
    expect(stale.navigate).not.toHaveBeenCalled();
  });
});

describe('startWorkQueuePlanExecution', () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    taskId: 'task-1',
    chatId: 'chat-1',
    resultSubChatId: 'sub-1',
    startExecution: vi.fn(async () => undefined),
    setPendingPlan: vi.fn(),
    recoverPlan: vi.fn(),
    onInvalidPlan: vi.fn(),
    ...overrides,
  });

  it('does nothing after a failed execution CAS', async () => {
    const startExecution = vi.fn(async () => {
      throw new Error('CAS lost');
    });
    const request = input({ startExecution });
    const deps = actions({
      getSubChat: vi.fn(async () => ({
        id: 'sub-1',
        messages: reviewedMessages,
      })),
    });

    await startWorkQueuePlanExecution(request, deps);

    expect(deps.navigate).not.toHaveBeenCalled();
    expect(request.setPendingPlan).not.toHaveBeenCalled();
    expect(request.recoverPlan).not.toHaveBeenCalled();
  });

  it.each([
    [{ role: 'assistant', parts: [null] }],
    [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: {
              status: 'awaiting_approval',
              summary: 'broken',
              planText: null,
            },
          },
        ],
      },
    ],
    [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: {
              planId: 'plan-without-text',
              status: 'awaiting_approval',
              planText: '   ',
            },
          },
        ],
      },
    ],
  ])('rejects malformed persisted plan parts without throwing', async (messages) => {
    const request = input();
    const deps = actions({
      getSubChat: vi.fn(async () => ({ id: 'sub-1', messages })),
    });

    await expect(startWorkQueuePlanExecution(request, deps)).resolves.toBeUndefined();

    expect(request.onInvalidPlan).toHaveBeenCalledWith(
      'Linked sub-chat has no eligible reviewed plan to execute.',
    );
    expect(request.startExecution).not.toHaveBeenCalled();
  });

  it('does not fall back to an older plan when the newest plan has no plan text', async () => {
    const request = input();
    const deps = actions({
      getSubChat: vi.fn(async () => ({
        id: 'sub-1',
        messages: [
          ...reviewedMessages,
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool-frink-plan',
                input: {
                  planId: 'newer',
                  summary: 's',
                  status: 'awaiting_approval',
                },
              },
            ],
          },
        ],
      })),
    });

    await startWorkQueuePlanExecution(request, deps);

    expect(request.onInvalidPlan).toHaveBeenCalledWith(
      'Linked sub-chat has no eligible reviewed plan to execute.',
    );
    expect(request.startExecution).not.toHaveBeenCalled();
  });

  it('recovers the exact approved plan without arming a delayed navigation trigger', async () => {
    let resolveCas!: () => void;
    const order: string[] = [];
    const request = input({
      startExecution: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCas = () => {
              order.push('cas');
              resolve();
            };
          }),
      ),
      recoverPlan: vi.fn(() => order.push('recover')),
    });
    const deps = actions({
      getSubChat: vi.fn(async () => ({
        id: 'sub-1',
        messages: reviewedMessages,
      })),
      navigate: vi.fn(() => false),
    });
    const pending = startWorkQueuePlanExecution(request, deps);
    await vi.waitFor(() => expect(request.startExecution).toHaveBeenCalledTimes(1));

    resolveCas();
    await pending;

    expect(order).toEqual(['cas', 'recover']);
    expect(request.setPendingPlan).not.toHaveBeenCalled();
    expect(request.recoverPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        subChatId: 'sub-1',
        approval: expect.objectContaining({
          flowDriven: false,
          context: expect.objectContaining({ planId: 'plan-1' }),
        }),
      }),
    );
  });

  it('lets the navigation winner arm the immediate plan trigger only after CAS', async () => {
    const order: string[] = [];
    const request = input({
      startExecution: vi.fn(async () => order.push('cas')),
      setPendingPlan: vi.fn(() => order.push('pending')),
    });
    const deps = actions({
      getSubChat: vi.fn(async () => ({
        id: 'sub-1',
        messages: reviewedMessages,
      })),
      navigate: vi.fn(() => {
        order.push('navigate');
        return true;
      }),
    });

    await startWorkQueuePlanExecution(request, deps);

    expect(order).toEqual(['cas', 'navigate', 'pending']);
    expect(request.setPendingPlan).toHaveBeenCalledWith('sub-1');
    expect(request.recoverPlan).not.toHaveBeenCalled();
  });
});
