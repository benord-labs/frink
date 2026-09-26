// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoizedAssistantMessages } from './messages-list';

const useAtomValueMock = vi.fn();

vi.mock('jotai', () => ({
  useAtomValue: (atom: unknown) => useAtomValueMock(atom),
}));

vi.mock('../stores/message-store', () => ({
  isLastMessageForSubChatAtomFamily: (key: string) => `isLast:${key}`,
  isStreamingForSubChatAtomFamily: (subChatId: string) => `isStreaming:${subChatId}`,
  messageAtomFamily: (messageId: string) => `message:${messageId}`,
  perSubChatStatusAtomFamily: (subChatId: string) => `status:${subChatId}`,
}));

vi.mock('./assistant-message-item', () => ({
  AssistantMessageItem: (props: { message: { id: string }; isLastAssistantMessage: boolean }) => (
    <div
      data-testid={`assistant-${props.message.id}`}
      data-last-assistant={String(props.isLastAssistantMessage)}
    />
  ),
}));

describe('MemoizedAssistantMessages', () => {
  beforeEach(() => {
    useAtomValueMock.mockImplementation((atom: unknown) => {
      if (typeof atom !== 'string') return null;
      if (atom.startsWith('message:')) {
        const id = atom.replace('message:', '');
        return { id, parts: [{ type: 'text', text: 'hi' }], metadata: {} };
      }
      if (atom.startsWith('isLast:')) {
        return atom.endsWith(':assistant-2');
      }
      if (atom.startsWith('isStreaming:')) return false;
      if (atom.startsWith('status:')) return 'ready';
      return null;
    });
  });

  it('marks only the final assistant message as last assistant', () => {
    render(
      <MemoizedAssistantMessages
        assistantMsgIds={['assistant-1', 'assistant-2']}
        subChatId="sub-1"
        chatId="chat-1"
        isMobile={false}
        sandboxSetupStatus="ready"
      />,
    );

    expect(screen.getByTestId('assistant-assistant-1')).toHaveAttribute(
      'data-last-assistant',
      'false',
    );
    expect(screen.getByTestId('assistant-assistant-2')).toHaveAttribute(
      'data-last-assistant',
      'true',
    );
  });

  // `isLastAssistantMessage` gates the turn's single Response label and its single action row, so
  // its scope decides whether chat HISTORY keeps those controls. It is per-TURN, not per-chat: each
  // turn renders its own MemoizedAssistantMessages over that turn's ids alone
  // (assistantIdsForSubChatMsgAtomFamily, keyed by the turn's user message). Both turns are mounted
  // together in a real chat, which is how this asserts it — an earlier turn keeps its own last
  // message, and therefore its own copy/usage row, while a later turn is on screen.
  it('gives every completed turn its own last assistant message', () => {
    const turn = (id: string) => (
      <MemoizedAssistantMessages
        assistantMsgIds={[id]}
        subChatId="sub-1"
        chatId="chat-1"
        isMobile={false}
        sandboxSetupStatus="ready"
      />
    );
    render(
      <>
        {turn('turn1-only')}
        {turn('turn2-only')}
      </>,
    );

    expect(screen.getByTestId('assistant-turn1-only')).toHaveAttribute(
      'data-last-assistant',
      'true',
    );
    expect(screen.getByTestId('assistant-turn2-only')).toHaveAttribute(
      'data-last-assistant',
      'true',
    );
  });
});
