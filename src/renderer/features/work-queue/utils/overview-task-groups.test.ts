import { describe, expect, it } from 'vitest';
import { getOverviewTaskChatId } from './overview-task-groups';

describe('getOverviewTaskChatId', () => {
  it('prefers task result, then the joined chat', () => {
    expect(
      getOverviewTaskChatId({
        result: { chatId: 'result-chat' },
        linkedChatId: 'linked-chat',
      }),
    ).toBe('result-chat');
    expect(getOverviewTaskChatId({ linkedChatId: 'linked-chat' })).toBe('linked-chat');
  });

  it('finds a later Flow agent chat in trigger context', () => {
    expect(
      getOverviewTaskChatId({
        triggerContext: {
          chatId: 'flow-chat',
          Config: { continueChatId: 'continue-chat' },
        },
      }),
    ).toBe('flow-chat');
    expect(
      getOverviewTaskChatId({
        triggerContext: { Config: { continueChatId: 'continue-chat' } },
      }),
    ).toBe('continue-chat');
    expect(
      getOverviewTaskChatId({
        triggerContext: { Config: { continueChatId: 'renderer-chat' } },
      }),
    ).toBe('renderer-chat');
  });
});
