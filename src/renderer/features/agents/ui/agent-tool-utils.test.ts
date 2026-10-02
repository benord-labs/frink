import { describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../stores/message-store';
import { areToolPropsEqual } from './agent-tool-utils';

describe('areToolPropsEqual', () => {
  it('re-renders a card whose message moved to another sub-chat', () => {
    const part = { type: 'tool-Bash', state: 'input-available', toolCallId: 'c1' } as MessagePart;

    expect(
      areToolPropsEqual(
        { part, chatStatus: 'streaming', subChatId: 'a' },
        { part, chatStatus: 'streaming', subChatId: 'b' },
      ),
    ).toBe(false);
  });

  describe('tool-Thinking streaming (toolCallId + input deltas)', () => {
    const thinkingStreaming = (text: string, toolCallId = 'thinking-test-1'): MessagePart => ({
      type: 'tool-Thinking',
      toolCallId,
      state: 'input-available',
      input: { text },
    });

    it('returns false when input text grows but state is unchanged (regression: memo must not block streaming UI)', () => {
      const prev = thinkingStreaming('The user is');
      const next = thinkingStreaming('The user is asking for a fix');
      expect(
        areToolPropsEqual(
          { part: prev, chatStatus: 'streaming' },
          { part: next, chatStatus: 'streaming' },
        ),
      ).toBe(false);
    });

    it('returns true when tool data is semantically equal (new object references)', () => {
      const a = thinkingStreaming('same text');
      const b: MessagePart = {
        type: 'tool-Thinking',
        toolCallId: 'thinking-test-1',
        state: 'input-available',
        input: { text: 'same text' },
      };
      expect(
        areToolPropsEqual(
          { part: a, chatStatus: 'streaming' },
          { part: b, chatStatus: 'streaming' },
        ),
      ).toBe(true);
    });

    it('returns false when chatStatus changes for pending thinking (spinner vs streaming)', () => {
      const part = thinkingStreaming('…');
      expect(
        areToolPropsEqual({ part, chatStatus: 'submitted' }, { part, chatStatus: 'streaming' }),
      ).toBe(false);
    });
  });
});

describe('arePartsEqual payload comparison', () => {
  const bashPart = (output: MessagePart['output']): MessagePart => ({
    type: 'tool-Bash',
    toolCallId: 'bash-test-1',
    state: 'output-available',
    input: { command: 'cat large-file' },
    output,
  });

  it('never serialises a multi-MB tool output and still reports unchanged vs changed', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    const output = { stdout: 'x'.repeat(4 * 1024 * 1024) };
    const prev = bashPart(output);
    // The message store re-copies `input` on every sync while `output` keeps its identity.
    const resynced: MessagePart = { ...prev, input: { ...prev.input } };
    const grown = bashPart({ stdout: `${output.stdout}!` });

    expect(areToolPropsEqual({ part: prev }, { part: resynced })).toBe(true);
    expect(areToolPropsEqual({ part: prev }, { part: grown })).toBe(false);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });
});
