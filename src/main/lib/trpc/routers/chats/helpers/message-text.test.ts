import { describe, expect, it } from 'vitest';
import { extractInitialMessageText } from './message-text';

describe('extractInitialMessageText', () => {
  it('prefers user text over task title when both exist', () => {
    const result = extractInitialMessageText({
      taskTitle: 'Fix OAuth callback race',
      initialMessageParts: [{ type: 'text', text: '<!--TASK_BUBBLE:{"id":"1"}--> hello there' }],
    });

    expect(result).toBe('hello there');
  });

  it('falls back to task title when user text is metadata-only', () => {
    const result = extractInitialMessageText({
      taskTitle: 'Fix OAuth callback race',
      initialMessageParts: [{ type: 'text', text: '<!--TASK_BUBBLE:{"id":"1"}-->' }],
    });

    expect(result).toBe('Fix OAuth callback race');
  });

  it('strips task marker metadata from multipart text', () => {
    const result = extractInitialMessageText({
      initialMessageParts: [
        {
          type: 'text',
          text: '<!--TASK_BUBBLE:{"id":"1","title":"T","description":"D"}--> Implement retry logic',
        },
      ],
    });

    expect(result).toBe('Implement retry logic');
  });

  it('strips trigger marker metadata from string message', () => {
    const result = extractInitialMessageText({
      initialMessage:
        '<!--TRIGGER_BUBBLE:{"source":"gmail","triggerRuleName":"When email"}--> New email triage task',
    });

    expect(result).toBe('New email triage task');
  });

  it('returns null when no user text or task title is present', () => {
    const result = extractInitialMessageText({
      initialMessageParts: [{ type: 'text', text: '<!--TASK_BUBBLE:{"id":"1"}-->' }],
    });

    expect(result).toBeNull();
  });
});
