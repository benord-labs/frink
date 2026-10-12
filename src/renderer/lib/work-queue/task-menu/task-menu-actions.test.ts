import { describe, expect, it } from 'vitest';
import { canCancelTask, canDeleteTask, canStartTask, taskMenuRecovery } from './task-menu-actions';

describe('taskMenuRecovery', () => {
  it.each([
    ['failed', null],
    ['needs_attention', { usageLimit: true }],
  ] as const)('offers the kind of a retryable %s task', (status, result) => {
    expect(taskMenuRecovery({ status, result, recoveryKind: 'continue' }, status)).toBe('continue');
  });

  it('offers nothing for a task parked on the user', () => {
    const task = { status: 'needs_attention', result: null, recoveryKind: 'retry' as const };
    expect(taskMenuRecovery(task, 'needs_attention')).toBeUndefined();
  });

  it('offers the kind of an interrupted run without assessing the task', () => {
    const task = { status: 'cancelled', result: null, recoveryKind: 'retry' as const };
    expect(taskMenuRecovery(task, 'interrupted')).toBe('retry');
  });

  it('offers nothing when the server sent no kind', () => {
    expect(taskMenuRecovery({ status: 'failed', result: null }, 'failed')).toBeUndefined();
  });

  it('offers nothing for a failure the retry policy refuses', () => {
    const task = {
      status: 'failed',
      result: { dispatchErrorCode: 'INVALID_MODEL' },
      recoveryKind: 'retry' as const,
    };
    expect(taskMenuRecovery(task, 'failed')).toBeUndefined();
  });

  it.each(['running', 'pending', 'done'] as const)('offers nothing for a %s task', (s) => {
    expect(taskMenuRecovery({ status: s, result: null, recoveryKind: 'retry' }, s)).toBeUndefined();
  });
});

describe('task menu exits', () => {
  const withChat = { result: null, linkedChatId: 'chat-1' };
  const withoutChat = { result: null };

  it.each([
    ['running', withoutChat, true, false, false],
    ['interrupted', withoutChat, true, false, false],
    ['failed', withoutChat, false, true, false],
    ['pending', withChat, true, false, false],
    ['pending', { result: { chatId: 'chat-1' } }, true, false, false],
    ['pending', withoutChat, false, true, true],
  ] as const)(
    '%s row %# offers its start and exit items',
    (status, task, cancels, deletes, starts) => {
      expect(canCancelTask(task, status)).toBe(cancels);
      expect(canDeleteTask(task, status)).toBe(deletes);
      expect(canStartTask(task, status)).toBe(starts);
    },
  );
});
