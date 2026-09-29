import { describe, expect, it } from 'vitest';
import { isTaskChatReadyData } from './task-chat-ready';

describe('isTaskChatReadyData', () => {
  it('accepts a valid payload', () => {
    expect(
      isTaskChatReadyData({
        chatId: 'c1',
        subChatId: 's1',
        taskId: 't1',
        prompt: 'run task',
        projectId: null,
        projectPath: null,
        startMode: 'plan',
        skipReview: false,
        headless: false,
      }),
    ).toBe(true);
  });

  it('rejects invalid start mode and skipReview types', () => {
    expect(
      isTaskChatReadyData({
        chatId: 'c1',
        subChatId: 's1',
        taskId: 't1',
        prompt: 'run task',
        projectPath: '/tmp',
        startMode: 'invalid',
        skipReview: 'yes',
      }),
    ).toBe(false);
  });

  it('accepts an optional Flow Auto Mode snapshot and rejects invalid values', () => {
    const payload = {
      chatId: 'c1',
      subChatId: 's1',
      taskId: 't1',
      prompt: 'run task',
      projectId: 'p1',
      projectPath: '/tmp',
      startMode: 'execute',
      skipReview: false,
      headless: true,
    };
    expect(isTaskChatReadyData({ ...payload, autoReviewTools: false })).toBe(true);
    expect(isTaskChatReadyData({ ...payload, autoReviewTools: 'false' })).toBe(false);
    expect(isTaskChatReadyData({ ...payload, codexSpeed: 'ultrafast' })).toBe(true);
    expect(isTaskChatReadyData({ ...payload, codexSpeed: 'standard' })).toBe(true);
    expect(isTaskChatReadyData({ ...payload, codexSpeed: true })).toBe(false);
    // A `null` here is the shape a main-process resolver leaks when it forwards getFlowConfigField
    // verbatim: it passes the `!== undefined` spread guards upstream and then sinks the WHOLE
    // payload here, so the chat never opens. Rejecting it loudly is what makes that bug findable.
    expect(isTaskChatReadyData({ ...payload, codexSpeed: null })).toBe(false);
  });

  it('rejects payloads missing required fields', () => {
    expect(
      isTaskChatReadyData({
        subChatId: 's1',
        taskId: 't1',
        prompt: 'run task',
        projectPath: '/tmp',
        startMode: 'execute',
        skipReview: false,
      }),
    ).toBe(false);

    expect(
      isTaskChatReadyData({
        chatId: 'c1',
        subChatId: 's1',
        taskId: 't1',
        prompt: 'run task',
        projectPath: '/tmp',
        skipReview: false,
      }),
    ).toBe(false);

    expect(
      isTaskChatReadyData({
        chatId: 'c1',
        subChatId: 's1',
        prompt: 'run task',
        projectPath: '/tmp',
        startMode: 'plan',
        skipReview: false,
      }),
    ).toBe(false);
  });
});
