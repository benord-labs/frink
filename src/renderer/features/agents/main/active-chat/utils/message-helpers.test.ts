// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../stores/message-store';
import { copyMessageContent, getMessageTextContent, hasUnapprovedPlan } from './message-helpers';

describe('copyMessageContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes full message text including emoji to clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const msg: Message = {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hi 😀 done' }],
    };

    copyMessageContent(msg);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('Hi 😀 done');
  });

  it('writes emoji-only message when only emoji is present', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const msg: Message = {
      id: 'm2',
      role: 'user',
      parts: [{ type: 'text', text: '🎉' }],
    };

    copyMessageContent(msg);

    expect(writeText).toHaveBeenCalledWith('🎉');
  });

  it('does not call clipboard when there is no extractable text', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    copyMessageContent({ id: 'e1', role: 'user', parts: [] });
    expect(writeText).not.toHaveBeenCalled();

    copyMessageContent({
      id: 'e2',
      role: 'assistant',
      parts: [{ type: 'tool-invocation', toolName: 'x' }],
    });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('getMessageTextContent', () => {
  it('includes a subagent’s prose, which reads as text but travels as a tool part', () => {
    const msg: Message = {
      id: 'm-subagent',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Dispatching an agent.' },
        { type: 'tool-Bash', toolCallId: 'a:1', input: { command: 'ls' } },
        { type: 'tool-SubagentText', toolCallId: 'a:2', input: { text: 'Found the handler.' } },
      ],
    };

    expect(getMessageTextContent(msg)).toBe('Dispatching an agent.\nFound the handler.');
  });

  it('skips a prose part with no usable text instead of copying a blank line', () => {
    const msg: Message = {
      id: 'm-empty-prose',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Answer.' },
        { type: 'tool-SubagentText', toolCallId: 'a:1', input: { text: '   ' } },
        { type: 'tool-SubagentText', toolCallId: 'a:2', input: {} },
      ],
    };

    expect(getMessageTextContent(msg)).toBe('Answer.');
  });

  it('joins multiple text parts with newlines and preserves emoji', () => {
    const msg: Message = {
      id: 'm3',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Line one 🎨' },
        { type: 'text', text: 'Line two ✅' },
      ],
    };
    expect(getMessageTextContent(msg)).toBe('Line one 🎨\nLine two ✅');
  });
});

describe('message-helpers plan utilities', () => {
  it('detects unapproved plan only while in plan mode', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: {
              planId: 'plan-ready',
              summary: 'Plan is ready for review.',
              status: 'awaiting_approval',
              planText: '## Plan\nImplement UI card',
            },
          },
        ],
      },
    ] as unknown as UIMessage[];

    expect(hasUnapprovedPlan(messages, true)).toBe(true);
    expect(hasUnapprovedPlan(messages, false)).toBe(false);
  });

  it('does not resurrect an approved plan when Plan mode is entered again', () => {
    const messages = [
      {
        id: 'assistant-plan',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: {
              planId: 'approved-plan',
              summary: 'Historical plan.',
              status: 'awaiting_approval',
              planText: '## Plan',
            },
          },
        ],
      },
      {
        id: 'approval-trigger',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'Implement the approved plan from the approved_plan context.',
          },
        ],
      },
      {
        id: 'new-plan-request',
        role: 'user',
        parts: [{ type: 'text', text: 'Plan another change.' }],
      },
    ] as unknown as UIMessage[];

    expect(hasUnapprovedPlan(messages, true)).toBe(false);
  });

  it('ignores non-canonical plan tool parts', () => {
    const messages = [
      {
        id: 'assistant-no-plan',
        role: 'assistant',
        parts: [
          {
            type: 'tool-PlanWrite',
            input: { action: 'create' },
            output: { success: true },
          },
        ],
      },
    ] as unknown as UIMessage[];

    expect(hasUnapprovedPlan(messages, true)).toBe(false);
  });
});
