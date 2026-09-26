import { Chat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { classifyDurableMessageRehydration } from '.';

const userMessage = (): UIMessage => ({
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Run the checks' }],
});

const assistantMessage = (text: string): UIMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  parts: [{ type: 'text', text }],
  metadata: { sdkMessageUuid: 'sdk-1', usage: { inputTokens: 1, outputTokens: 2 } },
});

const durableMessage = (id: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: id }],
});

const candidate = (
  existingMessages: UIMessage[],
  fetchedMessages: UIMessage[],
  overrides: Partial<{
    isActiveSubChat: boolean;
    isExistingChatStreaming: boolean;
  }> = {},
) => ({
  isActiveSubChat: true,
  isExistingChatStreaming: false,
  existingMessages,
  fetchedMessages,
  ...overrides,
});

describe('classifyDurableMessageRehydration', () => {
  it('recreates after finalize changes a checkpointed assistant row at equal count', () => {
    const checkpointed = [userMessage(), assistantMessage('partial output')];
    const finalized = [userMessage(), assistantMessage('partial output and durable tail')];

    expect(classifyDurableMessageRehydration(candidate(checkpointed, finalized))).toBe('replace');
  });

  it('keeps the existing Chat for a semantically identical equal-count refetch', () => {
    const existing = [userMessage(), assistantMessage('final output')];
    const identicalRefetch = [
      userMessage(),
      {
        ...assistantMessage('final output'),
        metadata: {
          usage: { outputTokens: 2, inputTokens: 1 },
          sdkMessageUuid: 'sdk-1',
        },
      },
    ];

    expect(classifyDurableMessageRehydration(candidate(existing, identicalRefetch))).toBe(
      'preserve',
    );
  });

  it('rehydrates an equal-count tail page after pagination shifts on append', () => {
    const existing = Array.from({ length: 20 }, (_, index) => durableMessage(`m${index + 1}`));
    const fetched = Array.from({ length: 20 }, (_, index) => durableMessage(`m${index + 2}`));

    expect(classifyDurableMessageRehydration(candidate(existing, fetched))).toBe('replace');
  });

  it('rehydrates when crossing the tail cap grows and shifts the page together', () => {
    const existing = Array.from({ length: 19 }, (_, index) => durableMessage(`m${index + 1}`));
    const fetched = Array.from({ length: 20 }, (_, index) => durableMessage(`m${index + 2}`));

    expect(classifyDurableMessageRehydration(candidate(existing, fetched))).toBe('replace');
  });

  it('preserves optimistic or in-flight local state', () => {
    const fetched = [userMessage(), assistantMessage('durable output')];
    const optimistic = [
      userMessage(),
      { ...assistantMessage('local optimistic output'), id: 'optimistic-assistant' },
    ];
    const inFlight = [
      userMessage(),
      Object.assign(assistantMessage('local streaming output'), { isInFlight: true }),
    ];

    expect(classifyDurableMessageRehydration(candidate(optimistic, fetched))).toBe('preserve');
    expect(classifyDurableMessageRehydration(candidate(inFlight, fetched))).toBe('preserve');
    expect(
      classifyDurableMessageRehydration(
        candidate([userMessage(), assistantMessage('local streaming output')], fetched, {
          isExistingChatStreaming: true,
        }),
      ),
    ).toBe('preserve');
  });

  it('does not replace divergent local identity merely because the durable page is longer', () => {
    const local = [{ ...userMessage(), id: 'optimistic-user' }];
    const durable = [userMessage(), assistantMessage('durable output')];

    expect(classifyDurableMessageRehydration(candidate(local, durable))).toBe('preserve');
  });
});

/** An assistant message whose text reports how many times a serialiser read it. */
function observedAssistant(text: string) {
  let reads = 0;
  const message: UIMessage = {
    ...assistantMessage(text),
    parts: [
      {
        type: 'text',
        get text() {
          reads += 1;
          return text;
        },
      },
    ],
  };
  return { message, reads: () => reads };
}

describe('classifyDurableMessageRehydration memoisation', () => {
  it('compares an unchanged input pair once', () => {
    const observed = observedAssistant('done');
    const existing = [userMessage(), observed.message];
    const fetched = [userMessage(), assistantMessage('done')];
    expect(classifyDurableMessageRehydration(candidate(existing, fetched))).toBe('preserve');
    const readsAfterFirst = observed.reads();
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(classifyDurableMessageRehydration(candidate(existing, fetched))).toBe('preserve');
    expect(observed.reads()).toBe(readsAfterFirst);
  });

  it('re-guards a memoised pair once the chat starts streaming', () => {
    const existing = [userMessage(), assistantMessage('checkpoint')];
    const fetched = [userMessage(), assistantMessage('finalised')];
    expect(classifyDurableMessageRehydration(candidate(existing, fetched))).toBe('replace');
    expect(
      classifyDurableMessageRehydration(
        candidate(existing, fetched, { isExistingChatStreaming: true }),
      ),
    ).toBe('preserve');
  });

  it('re-guards a memoised pair once a message is in flight', () => {
    const trailing: UIMessage & { inFlight?: boolean } = assistantMessage('checkpoint');
    const existing = [userMessage(), trailing];
    const fetched = [userMessage(), assistantMessage('finalised')];
    expect(classifyDurableMessageRehydration(candidate(existing, fetched))).toBe('replace');
    trailing.inFlight = true;
    expect(classifyDurableMessageRehydration(candidate(existing, fetched))).toBe('preserve');
  });

  it('treats a chat built from the fetched page as current without comparing', () => {
    const observed = observedAssistant('done');
    const page = [userMessage(), observed.message];
    expect(classifyDurableMessageRehydration(candidate(page, page))).toBe('preserve');
    expect(observed.reads()).toBe(0);
  });

  it('compares again when the durable page is a new array', () => {
    const existing = [userMessage(), assistantMessage('checkpoint')];
    expect(
      classifyDurableMessageRehydration(
        candidate(existing, [userMessage(), assistantMessage('checkpoint')]),
      ),
    ).toBe('preserve');
    expect(
      classifyDurableMessageRehydration(
        candidate(existing, [userMessage(), assistantMessage('finalised')]),
      ),
    ).toBe('replace');
  });
});

describe('AI SDK chat state', () => {
  it('replaces the messages array on every write, so identity tracks revisions', () => {
    const chat = new Chat<UIMessage>({ messages: [userMessage()] });
    const initial = chat.messages;
    chat.messages = [...initial, assistantMessage('done')];
    expect(chat.messages).not.toBe(initial);
  });
});
