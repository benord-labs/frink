import { describe, expect, it } from 'vitest';
import type { MessageSendPayload } from '../../client';
import { classifyMessageOrigin, describeDelivery } from './origin';

const typed: MessageSendPayload = {
  chatId: 'c1',
  subChatId: 's-typed',
  projectId: 'p1',
  trigger: 'submit-message',
  userMessage: { id: 'u-typed', role: 'user', parts: [{ type: 'text', text: 'I edited it' }] },
};

// A dispatched message's metadata arrives over IPC with the marker beside its declared keys.
const dispatchedMetadata = { sessionId: 'sess-1', source: 'flow-dispatch' };

const classify = (over: Partial<MessageSendPayload> = {}, text = 'I edited it') =>
  classifyMessageOrigin({ ...typed, ...over }, text);

describe('classifyMessageOrigin', () => {
  it('identifies ordinary composer, park-answer and mobile sends', () => {
    expect(classify()).toEqual({ source: 'person', kind: 'message' });
    expect(classify({ expectedFlowTaskId: 'task-1' })).toEqual({
      source: 'person',
      kind: 'message',
    });
  });

  it('preserves machine-marker precedence and separates task dispatch from Flow evidence', () => {
    expect(classify({ dispatchTaskId: 'task-1' })).toEqual({ source: 'internal', kind: 'message' });
    expect(
      classify({ approvedPlanContext: { planId: 'p', planText: 'x' }, dispatchTaskId: 't' }),
    ).toEqual({ source: 'internal', kind: 'plan_approval' });
    expect(classify({ trigger: 'regenerate-message', dispatchTaskId: 't' })).toEqual({
      source: 'internal',
      kind: 'regenerate',
    });
    expect(
      classify({ userMessage: { ...typed.userMessage, metadata: dispatchedMetadata } }),
    ).toEqual({ source: 'flow', kind: 'message' });
    expect(classify({}, '<!--FRINK_HIDDEN_WAKE-->Continue the paused run.')).toEqual({
      source: 'internal',
      kind: 'wake',
    });
  });

  it('requires the exact marker value, not a look-alike', () => {
    const lookalike = { sessionId: 'sess-1', source: 'flow-dispatch-ish' };
    expect(classify({ userMessage: { ...typed.userMessage, metadata: lookalike } })).toEqual({
      source: 'person',
      kind: 'message',
    });
  });
});

describe('describeDelivery', () => {
  it('pairs the classification with the send’s own dispatch task id', () => {
    expect(describeDelivery({ ...typed, dispatchTaskId: 'task-9' }, 'go')).toEqual({
      messageOrigin: { source: 'internal', kind: 'message' },
      dispatchTaskId: 'task-9',
    });
  });
});
