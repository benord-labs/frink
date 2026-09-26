import { describe, expect, it } from 'vitest';
import { createThinkingEmitter } from './thinking-emitter';

describe('createThinkingEmitter', () => {
  it('does not emit tool-input-delta (plain text is not partial JSON for the AI SDK)', () => {
    const thinking = createThinkingEmitter();
    const d1 = thinking.delta('hello');
    const d2 = thinking.delta(' world');
    const all = [...d1, ...d2, ...thinking.complete()];
    expect(all.some((c) => c.type === 'tool-input-delta')).toBe(false);
  });

  it('emits tool-input-start then repeated tool-input-available with growing text and providerExecuted', () => {
    const thinking = createThinkingEmitter();
    const first = thinking.delta('a');
    expect(first[0]).toMatchObject({
      type: 'tool-input-start',
      toolName: 'Thinking',
    });
    expect(first[1]).toEqual({
      type: 'tool-input-available',
      toolCallId: (first[0] as { toolCallId: string }).toolCallId,
      toolName: 'Thinking',
      input: { text: 'a' },
      providerExecuted: true,
    });

    const second = thinking.delta('b');
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual({
      type: 'tool-input-available',
      toolCallId: (first[0] as { toolCallId: string }).toolCallId,
      toolName: 'Thinking',
      input: { text: 'ab' },
      providerExecuted: true,
    });
  });

  it('complete emits final tool-input-available and tool-output-available then clears state', () => {
    const thinking = createThinkingEmitter();
    thinking.delta('x');
    const done = thinking.complete();
    expect(done).toHaveLength(2);
    expect(done[0]).toMatchObject({
      type: 'tool-input-available',
      toolName: 'Thinking',
      input: { text: 'x' },
      providerExecuted: true,
    });
    expect(done[1]).toEqual({
      type: 'tool-output-available',
      toolCallId: (done[0] as { toolCallId: string }).toolCallId,
      output: { completed: true },
    });
    expect(thinking.isActive()).toBe(false);
    expect(thinking.complete()).toEqual([]);
  });

  it('reset clears an active block without emitting', () => {
    const thinking = createThinkingEmitter();
    thinking.delta('partial');
    thinking.reset();
    expect(thinking.isActive()).toBe(false);
    expect(thinking.complete()).toEqual([]);
  });
});
