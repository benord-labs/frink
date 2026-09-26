// @vitest-environment happy-dom
/**
 * The retire contract: a question card is retired ONLY by a chunk carrying its own toolUseId.
 * Ambient stream traffic — a concurrent background subagent's tool outputs, forwarded text, turn
 * boundaries — must never retire it, because a pending canUseTool does not stall the SDK stream
 * and other actors keep streaming on the same sub-chat.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '../../../../lib/jotai-store';
import {
  askUserQuestionResultsAtom,
  expiredUserQuestionsAtom,
  pendingUserQuestionsAtom,
} from '../../atoms';
import { applyAskUserQuestionChunk } from '.';

const SUB_CHAT = 'sub-1';
const QUESTIONS = [
  {
    question: 'Proceed?',
    header: 'Choice',
    options: [{ label: 'Yes', description: 'go' }],
    multiSelect: false,
  },
];

function raiseQuestion(toolUseId = 'ask-1'): void {
  applyAskUserQuestionChunk({
    chunk: { type: 'ask-user-question', toolUseId, questions: QUESTIONS },
    subChatId: SUB_CHAT,
    parentChatId: 'chat-1',
  });
}

function pendingFor(subChatId: string) {
  return [...appStore.get(pendingUserQuestionsAtom).values()].find(
    (pending) => pending.subChatId === subChatId,
  );
}

function apply(chunk: { type: string; toolUseId?: string; toolCallId?: string; result?: string }) {
  applyAskUserQuestionChunk({ chunk, subChatId: SUB_CHAT, parentChatId: 'chat-1' });
}

beforeEach(() => {
  appStore.set(pendingUserQuestionsAtom, new Map());
  appStore.set(expiredUserQuestionsAtom, new Map());
  appStore.set(askUserQuestionResultsAtom, new Map());
});

describe('applyAskUserQuestionChunk retire rule', () => {
  it('keeps the card open across a concurrent subagent tool output, text and finish', () => {
    raiseQuestion();
    apply({ type: 'tool-output-available', toolCallId: 'task-9:child-3' });
    apply({ type: 'text-delta' });
    apply({ type: 'finish' });
    expect(pendingFor(SUB_CHAT)?.toolUseId).toBe('ask-1');
  });

  it("retires on the question's own tool-output-available", () => {
    raiseQuestion();
    apply({ type: 'tool-output-available', toolCallId: 'ask-1' });
    expect(pendingFor(SUB_CHAT)).toBeUndefined();
  });

  it("retires on the question's own tool-output-error", () => {
    raiseQuestion();
    apply({ type: 'tool-output-error', toolCallId: 'ask-1' });
    expect(pendingFor(SUB_CHAT)).toBeUndefined();
  });

  it('ignores tool-output-error for a different tool call', () => {
    raiseQuestion();
    apply({ type: 'tool-output-error', toolCallId: 'other-tool' });
    expect(pendingFor(SUB_CHAT)?.toolUseId).toBe('ask-1');
  });

  it('retires on a matching ask-user-question-result with no tool output (the abort shape)', () => {
    // Deny/skip/teardown emit only this chunk when the subprocess dies before any tool_result.
    raiseQuestion();
    apply({ type: 'ask-user-question-result', toolUseId: 'ask-1', result: 'Skipped' });
    expect(pendingFor(SUB_CHAT)).toBeUndefined();
    expect(appStore.get(askUserQuestionResultsAtom).get('ask-1')).toBe('Skipped');
  });

  it('records but does not retire on a foreign ask-user-question-result', () => {
    raiseQuestion();
    apply({ type: 'ask-user-question-result', toolUseId: 'stale-ask', result: 'Skipped' });
    expect(pendingFor(SUB_CHAT)?.toolUseId).toBe('ask-1');
    expect(appStore.get(askUserQuestionResultsAtom).get('stale-ask')).toBe('Skipped');
  });

  it('moves a matching timeout to expired, keeping it answerable', () => {
    raiseQuestion();
    apply({ type: 'ask-user-question-timeout', toolUseId: 'ask-1' });
    expect(pendingFor(SUB_CHAT)).toBeUndefined();
    expect(appStore.get(expiredUserQuestionsAtom).get('ask-1')?.toolUseId).toBe('ask-1');
  });

  it('preserves parallel timed-out questions under exact tool identities', () => {
    raiseQuestion('ask-1');
    raiseQuestion('ask-2');

    apply({ type: 'ask-user-question-timeout', toolUseId: 'ask-1' });
    apply({ type: 'ask-user-question-timeout', toolUseId: 'ask-2' });

    expect([...appStore.get(expiredUserQuestionsAtom).keys()]).toEqual(['ask-1', 'ask-2']);
    expect(appStore.get(pendingUserQuestionsAtom)).toEqual(new Map());
  });

  it('queues parallel questions and retires them independently', () => {
    raiseQuestion('ask-1');
    raiseQuestion('ask-2');
    expect([...appStore.get(pendingUserQuestionsAtom).keys()]).toEqual(['ask-1', 'ask-2']);
    expect(pendingFor(SUB_CHAT)?.toolUseId).toBe('ask-1');
    apply({ type: 'tool-output-available', toolCallId: 'ask-1' });
    expect(pendingFor(SUB_CHAT)?.toolUseId).toBe('ask-2');
  });
});
