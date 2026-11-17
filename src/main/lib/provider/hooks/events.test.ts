import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_RULES, type HookEventRule } from './events';

describe('HOOK_EVENT_RULES', () => {
  it('has a rule for every event the SDK knows and no other', () => {
    expect(Object.keys(HOOK_EVENT_RULES).sort()).toEqual([...HOOK_EVENTS].sort());
  });

  // Copied from the matcher table of Claude's hooks reference.
  it('matches each event on the input field the reference names', () => {
    const matchers = Object.entries(HOOK_EVENT_RULES).map(
      ([event, rule]) => `${event}: ${rule.matcher ?? 'always fires'}`,
    );
    expect(matchers).toEqual([
      'PreToolUse: tool_name',
      'PostToolUse: tool_name',
      'PostToolUseFailure: tool_name',
      'PostToolBatch: always fires',
      'Notification: notification_type',
      'UserPromptSubmit: always fires',
      'UserPromptExpansion: command_name',
      'SessionStart: source',
      'SessionEnd: reason',
      'Stop: always fires',
      'StopFailure: error',
      'SubagentStart: agent_type',
      'SubagentStop: agent_type',
      'PreCompact: trigger',
      'PostCompact: trigger',
      'PreModelSwitch: to_model',
      'PostModelSwitch: to_model',
      'PermissionRequest: tool_name',
      'PermissionDenied: tool_name',
      'Setup: trigger',
      'TeammateIdle: always fires',
      'TaskCreated: always fires',
      'TaskCompleted: always fires',
      'Elicitation: mcp_server_name',
      'ElicitationResult: mcp_server_name',
      'ConfigChange: source',
      'WorktreeCreate: always fires',
      'WorktreeRemove: always fires',
      'InstructionsLoaded: load_reason',
      'CwdChanged: always fires',
      'FileChanged: file_path',
      'DirectoryAdded: source',
      'MessageDisplay: always fires',
    ]);
  });

  // Copied from the per-event sections of Claude's hooks reference.
  it.each<[keyof HookEventRule, HookEventRule[keyof HookEventRule], string]>([
    ['narrowMatcher', true, 'StopFailure FileChanged'],
    [
      'exit2',
      'blocks',
      'PreToolUse UserPromptSubmit UserPromptExpansion Stop SubagentStop TeammateIdle TaskCreated ' +
        'TaskCompleted ConfigChange PostToolBatch PreCompact PreModelSwitch Elicitation ' +
        'ElicitationResult WorktreeCreate WorktreeRemove',
    ],
    ['exit2', 'tells-claude', 'PostToolUse PostToolUseFailure'],
    [
      'exit2',
      'tells-user',
      'SubagentStart SessionStart SessionEnd CwdChanged FileChanged PostCompact PostModelSwitch',
    ],
    ['exit2', 'unhonoured', 'PermissionRequest'],
    [
      'exit2',
      'ignored',
      'Notification StopFailure PermissionDenied Setup InstructionsLoaded DirectoryAdded ' +
        'MessageDisplay',
    ],
    ['exit2DropsSpecific', true, 'Elicitation ElicitationResult MessageDisplay'],
    ['alsoBlocksOn', 'timeout', 'PreModelSwitch'],
    ['alsoBlocksOn', 'failure', 'WorktreeCreate WorktreeRemove'],
    ['stdout', 'context', 'UserPromptSubmit UserPromptExpansion SessionStart PostModelSwitch'],
    ['stdout', 'path', 'WorktreeCreate'],
    [
      'decision',
      true,
      'UserPromptSubmit UserPromptExpansion PostToolUse PostToolUseFailure PostToolBatch Stop ' +
        'SubagentStop ConfigChange PreCompact TaskCreated PreToolUse PreModelSwitch',
    ],
    ['discards', 'continue', 'CwdChanged FileChanged DirectoryAdded TaskCreated'],
    [
      'discards',
      'common',
      'Notification MessageDisplay ConfigChange WorktreeCreate PreCompact PostCompact Elicitation ' +
        'ElicitationResult PermissionDenied',
    ],
    ['discards', 'output', 'SessionEnd StopFailure Setup InstructionsLoaded WorktreeRemove'],
  ])('sets %s to %j on exactly the events the reference names', (column, value, events) => {
    const set = HOOK_EVENTS.filter((event) => HOOK_EVENT_RULES[event][column] === value);
    expect(set.sort()).toEqual(events.split(' ').sort());
  });
});
