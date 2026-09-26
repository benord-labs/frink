import { describe, expect, it } from 'vitest';
import type { TaskResultRecord } from '../../../../shared/types/task-result';
import { getOverviewTaskChatId, groupOverviewTaskRows } from './overview-task-groups';

type Row = {
  id: string;
  status: string;
  effectiveStatus?: string;
  triggerContext?: TaskResultRecord | null;
};

function row(overrides: Partial<Row> & Pick<Row, 'id'>): Row {
  return {
    status: 'pending',
    triggerContext: null,
    ...overrides,
  };
}

describe('groupOverviewTaskRows', () => {
  it('keeps only manual-pickup work in the overview Inbox', () => {
    const waitTask = row({
      id: 'wait',
      triggerContext: { Config: { startMode: 'wait' } },
    });
    const executeTask = row({
      id: 'execute',
      triggerContext: { Config: { startMode: 'execute' } },
    });

    const result = groupOverviewTaskRows([waitTask, executeTask], [], []);

    expect(result.attentionRows).toEqual([]);
    expect(result.waitingRows).toEqual([waitTask]);
    expect(result.runningRows).toEqual([]);
  });

  it('moves a collapsed flow wait task out of Running without changing its raw status', () => {
    const flowWaitTask = row({
      id: 'flow-wait',
      status: 'pending',
      effectiveStatus: 'running',
      triggerContext: { Config: { startMode: 'wait' } },
    });
    const runningTask = row({
      id: 'running',
      status: 'running',
      effectiveStatus: 'running',
    });

    const result = groupOverviewTaskRows([], [flowWaitTask, runningTask], []);

    expect(result.waitingRows).toEqual([flowWaitTask]);
    expect(result.runningRows).toEqual([runningTask]);
    expect(flowWaitTask.status).toBe('pending');
  });

  it('deduplicates wait rows by id', () => {
    const stale = row({
      id: 'wait',
      triggerContext: { Config: { startMode: 'wait' } },
    });
    const fresh = { ...stale, effectiveStatus: 'running' };

    const result = groupOverviewTaskRows([stale], [fresh], []);

    expect(result.waitingRows).toEqual([fresh]);
  });

  it('orders every actionable state on the overview and keeps closed work out', () => {
    const plan = row({ id: 'plan', status: 'plan_ready' });
    const question = row({ id: 'question', status: 'needs_attention' });
    const interrupted = row({
      id: 'interrupted',
      status: 'cancelled',
      effectiveStatus: 'interrupted',
    });
    const failed = row({ id: 'failed', status: 'running', effectiveStatus: 'failed' });
    const running = row({ id: 'running', status: 'running' });
    const done = row({ id: 'done', status: 'done' });
    const completed = row({ id: 'completed', status: 'done', effectiveStatus: 'completed' });
    const cancelled = row({ id: 'cancelled', status: 'cancelled' });

    const result = groupOverviewTaskRows(
      [],
      [failed, running, interrupted, plan, question],
      [completed, done, cancelled],
    );

    expect(result.attentionRows).toEqual([plan, question, interrupted, failed, done]);
  });
});

describe('getOverviewTaskChatId', () => {
  it('prefers task result, then the joined chat', () => {
    expect(
      getOverviewTaskChatId({
        id: 'wait',
        status: 'pending',
        result: { chatId: 'result-chat' },
        linkedChatId: 'linked-chat',
      }),
    ).toBe('result-chat');
    expect(
      getOverviewTaskChatId({ id: 'wait', status: 'pending', linkedChatId: 'linked-chat' }),
    ).toBe('linked-chat');
  });

  it('finds a later Flow agent chat in trigger context', () => {
    expect(
      getOverviewTaskChatId({
        id: 'flow-wait',
        status: 'pending',
        triggerContext: {
          chatId: 'flow-chat',
          Config: { continueChatId: 'continue-chat' },
        },
      }),
    ).toBe('flow-chat');
    expect(
      getOverviewTaskChatId({
        id: 'flow-wait',
        status: 'pending',
        triggerContext: { Config: { continueChatId: 'continue-chat' } },
      }),
    ).toBe('continue-chat');
    expect(
      getOverviewTaskChatId({
        id: 'flow-wait',
        status: 'pending',
        triggerContext: { Config: { continueChatId: 'renderer-chat' } },
      }),
    ).toBe('renderer-chat');
  });
});
