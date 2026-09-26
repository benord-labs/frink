import { describe, expect, it } from 'vitest';
import {
  FRINK_TASK_SIGNAL_INTEGRATION_INACTIVE_MESSAGE,
  isFrinkTaskSignalToolName,
} from './claude-task-signal-tool-name';

describe('isFrinkTaskSignalToolName', () => {
  it('matches bare tool name', () => {
    expect(isFrinkTaskSignalToolName('frink_task_signal')).toBe(true);
  });

  it('matches Claude Agent SDK MCP-prefixed name', () => {
    expect(isFrinkTaskSignalToolName('mcp__frink_dynamic_chat__frink_task_signal')).toBe(true);
  });

  it('rejects unrelated tools', () => {
    expect(isFrinkTaskSignalToolName('Read')).toBe(false);
    expect(isFrinkTaskSignalToolName('mcp__frink_dynamic_chat__frink_other')).toBe(false);
  });

  it('rejects other MCP servers that only share the frink_task_signal suffix', () => {
    expect(isFrinkTaskSignalToolName('mcp__other_server__frink_task_signal')).toBe(false);
  });
});

describe('FRINK_TASK_SIGNAL_INTEGRATION_INACTIVE_MESSAGE', () => {
  it('is the stable canUseTool deny text when task-signal integration is not active (claude router)', () => {
    expect(FRINK_TASK_SIGNAL_INTEGRATION_INACTIVE_MESSAGE).toContain('dynamic chat MCP not active');
    expect(FRINK_TASK_SIGNAL_INTEGRATION_INACTIVE_MESSAGE.length).toBeGreaterThan(20);
  });
});
