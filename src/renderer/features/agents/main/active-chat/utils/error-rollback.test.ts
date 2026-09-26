import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { pruneFailedExecutionShell } from './error-rollback';

function textMessage(role: 'user' | 'assistant', text: string): UIMessage {
  return {
    id: `${role}-${Math.random()}`,
    role,
    parts: [{ type: 'text', text }],
  } as UIMessage;
}

describe('pruneFailedExecutionShell', () => {
  it('returns empty array when no messages exist', () => {
    const result = pruneFailedExecutionShell([]);
    expect(result).toEqual([]);
  });

  it('returns unchanged when last message is a user message', () => {
    const user = textMessage('user', 'hi');
    const result = pruneFailedExecutionShell([user]);
    expect(result).toEqual([user]);
  });

  it('removes an empty assistant shell but keeps failed user turn', () => {
    const user = textMessage('user', 'hello');
    const emptyAssistant = {
      id: 'assistant-empty',
      role: 'assistant',
      parts: [],
    } as UIMessage;

    const result = pruneFailedExecutionShell([user, emptyAssistant]);
    expect(result).toEqual([user]);
  });

  it('keeps assistant message when it has meaningful text', () => {
    const user = textMessage('user', 'hello');
    const assistant = textMessage('assistant', 'working on it');

    const result = pruneFailedExecutionShell([user, assistant]);
    expect(result).toEqual([user, assistant]);
  });

  it('keeps assistant message when it has toolCallId without text', () => {
    const user = textMessage('user', 'hello');
    const assistantWithToolCall = {
      id: 'assistant-tool-call',
      role: 'assistant',
      parts: [
        {
          type: 'tool-RunTool',
          toolCallId: 'tool-123',
          state: 'output-available',
          input: {},
          output: {},
        },
      ],
    } as UIMessage;

    const result = pruneFailedExecutionShell([user, assistantWithToolCall]);
    expect(result).toEqual([user, assistantWithToolCall]);
  });

  it('prunes assistant message when it contains only whitespace text', () => {
    const user = textMessage('user', 'hello');
    const whitespaceAssistant = {
      id: 'assistant-whitespace',
      role: 'assistant',
      parts: [{ type: 'text', text: '   \n\t  ' }],
    } as UIMessage;

    const result = pruneFailedExecutionShell([user, whitespaceAssistant]);
    expect(result).toEqual([user]);
  });
});
