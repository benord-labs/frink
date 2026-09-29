import { describe, expect, it } from 'vitest';
import type { MobileMessage } from '@frink/shared/types/remote/mobile';
import { contentGroups, copyText, toolLabel, toolRunSummary, type Tool } from './parts';

const tool = (name: string, state: Tool['state'] = 'completed'): Tool => ({
  type: 'tool',
  id: name,
  name,
  state,
});

describe('contentGroups', () => {
  it('merges adjacent tool steps and keeps steers in reading order', () => {
    const message: MobileMessage = {
      id: 'm',
      role: 'assistant',
      text: '',
      parts: [
        tool('Grep'),
        tool('Read'),
        { type: 'text', text: 'Found it.' },
        { type: 'steer', text: 'Use the helper.' },
        { type: 'text', text: '  ' },
        tool('Edit'),
      ],
    };
    expect(contentGroups(message).map((group) => group.type)).toEqual([
      'tools',
      'text',
      'steer',
      'tools',
    ]);
  });

  it('falls back to the plain text when a message has no parts', () => {
    expect(contentGroups({ id: 'm', role: 'user', text: 'Hi' })).toEqual([
      { type: 'text', text: 'Hi' },
    ]);
  });
});

it('copies prose only', () => {
  expect(
    copyText([
      { type: 'text', text: 'One' },
      { type: 'tools', tools: [tool('Bash')] },
      { type: 'steer', text: 'Not me' },
      { type: 'text', text: 'Two' },
    ]),
  ).toBe('One\n\nTwo');
});

describe('toolRunSummary', () => {
  it('names the step that is running', () => {
    expect(toolRunSummary([tool('Read'), tool('Bash', 'running')])).toEqual({
      label: 'Working · Running a command',
      state: 'running',
    });
  });

  it('counts finished steps and never hides a failure or a stop', () => {
    expect(toolRunSummary([tool('A')]).label).toBe('Worked · 1 step');
    expect(toolRunSummary([tool('A'), tool('B', 'failed')]).label).toBe(
      'Worked · 2 steps · 1 failed',
    );
    expect(toolRunSummary([tool('A'), tool('B', 'interrupted')])).toEqual({
      label: 'Stopped · 2 steps',
      state: 'stopped',
    });
  });
});

describe('toolLabel', () => {
  it('says what common tools do in plain words', () => {
    expect(toolLabel('Bash')).toBe('Running a command');
    expect(toolLabel('MultiEdit')).toBe('Editing files');
    expect(toolLabel('Glob')).toBe('Searching the code');
    expect(toolLabel('TodoWrite')).toBe('Updating the plan');
  });

  it('names the service behind a connected tool', () => {
    expect(toolLabel('mcp__github__create_issue')).toBe('Using github');
    expect(toolLabel('mcp__claude_ai_Linear__list_issues')).toBe('Using Linear');
  });

  it('keeps any other name as it is', () => {
    expect(toolLabel('Release task')).toBe('Release task');
  });
});
