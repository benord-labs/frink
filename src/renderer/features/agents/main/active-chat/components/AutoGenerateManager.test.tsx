// @vitest-environment happy-dom

import { render } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { AutoGenerateManager } from './AutoGenerateManager';

function makeUserMessage(text: string): UIMessage {
  return {
    id: 'msg-1',
    role: 'user',
    parts: [{ type: 'text', text }],
  } as UIMessage;
}

function makeAssistantMessage(opts: { id?: string; text: string }): UIMessage {
  const { id = 'msg-assistant', text } = opts;
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
  } as UIMessage;
}

describe('AutoGenerateManager', () => {
  it('calls regenerate exactly once when first-message conditions are met', () => {
    const regenerate = vi.fn();
    const hasTriggeredAutoGenerateRef = { current: false };

    const { rerender } = render(
      <AutoGenerateManager
        hasExistingSession={false}
        messages={[makeUserMessage('hello')]}
        status="ready"
        streamId={null}
        hasTriggeredAutoGenerateRef={hasTriggeredAutoGenerateRef}
        regenerate={regenerate}
      />,
    );

    rerender(
      <AutoGenerateManager
        hasExistingSession={false}
        messages={[makeUserMessage('hello')]}
        status="ready"
        streamId={null}
        hasTriggeredAutoGenerateRef={hasTriggeredAutoGenerateRef}
        regenerate={regenerate}
      />,
    );

    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('does not auto-generate when streamId exists', () => {
    const regenerate = vi.fn();
    const hasTriggeredAutoGenerateRef = { current: false };

    render(
      <AutoGenerateManager
        hasExistingSession={false}
        messages={[makeUserMessage('hello')]}
        status="ready"
        streamId="stream-1"
        hasTriggeredAutoGenerateRef={hasTriggeredAutoGenerateRef}
        regenerate={regenerate}
      />,
    );

    expect(regenerate).not.toHaveBeenCalled();
  });

  it('does not auto-generate when sub-chat already has an existing session (e.g. after chat move)', () => {
    const regenerate = vi.fn();
    const hasTriggeredAutoGenerateRef = { current: false };

    render(
      <AutoGenerateManager
        hasExistingSession
        messages={[makeUserMessage('hello')]}
        status="ready"
        streamId={null}
        hasTriggeredAutoGenerateRef={hasTriggeredAutoGenerateRef}
        regenerate={regenerate}
      />,
    );

    expect(regenerate).not.toHaveBeenCalled();
  });

  it('does not auto-generate when all messages are assistant-only (flow chat_reply)', () => {
    const regenerate = vi.fn();
    const hasTriggeredAutoGenerateRef = { current: false };

    render(
      <AutoGenerateManager
        hasExistingSession={false}
        messages={[makeAssistantMessage({ id: 'msg-flow', text: 'Flow completed!' })]}
        status="ready"
        streamId={null}
        hasTriggeredAutoGenerateRef={hasTriggeredAutoGenerateRef}
        regenerate={regenerate}
      />,
    );

    expect(regenerate).not.toHaveBeenCalled();
  });
});
