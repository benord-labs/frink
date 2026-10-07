import { vi } from 'vitest';
import type { AttentionTaskActions } from '../AttentionCarousel';

export function makeTaskActions(
  overrides: Partial<AttentionTaskActions> = {},
): AttentionTaskActions {
  return {
    isLoading: false,
    onCancel: vi.fn(),
    onDelete: vi.fn(),
    onMarkComplete: vi.fn(),
    onOpenChat: vi.fn(),
    onRetryTask: vi.fn(),
    onStartExecution: vi.fn(),
    onStartTask: vi.fn(),
    ...overrides,
  };
}

export function reviewedPlanMessages() {
  return [
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool-frink-plan',
          input: {
            planId: 'plan-review',
            summary: 'Implement the reviewed plan',
            planText: '## Plan\nImplement it',
            status: 'awaiting_approval',
          },
        },
      ],
    },
  ];
}

export function buildFailedRetryRow(taskId: string, createdAt: string, title = 'Retry me') {
  return {
    id: taskId,
    title,
    description: 'Failed and retriable',
    status: 'failed' as const,
    source: 'manual',
    result: null,
    createdAt,
    projectName: null,
    projectId: null,
    linkedChatId: null,
    triggerContext: null,
    recoveryKind: 'continue' as const,
  };
}
