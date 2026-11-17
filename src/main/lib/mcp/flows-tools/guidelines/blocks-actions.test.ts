import { describe, expect, it } from 'vitest';
import { getBlocksActionsGuideline } from './blocks-actions';

describe('getBlocksActionsGuideline', () => {
  // Agents wire Chat Reply from this text; promising a post-task chat that may be absent breaks runs.
  it('says a post-task chat is not always present and an upstream Start Task chat comes first', () => {
    const text = getBlocksActionsGuideline();
    expect(text).toContain('`trigger.chatId` is not always present');
    expect(text).toContain("An upstream Start Task's chat is used first.");
  });
});
