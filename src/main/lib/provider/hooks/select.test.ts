import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { HookRegistration } from '../../../../shared/types/hook-inventory';
import { selectHooks } from './select';

const BASE = { session_id: 's', transcript_path: '/dev/null', cwd: '/work' };

function hook(event: string, fields: Partial<HookRegistration> = {}): HookRegistration {
  return {
    id: `project:${event}:0:0`,
    scope: 'project',
    file: '/work/.claude/settings.json',
    event,
    handlerType: 'command',
    label: 'check.sh',
    command: './check.sh',
    binding: { status: 'supported', ignored: [] },
    ...fields,
  };
}

function toolCall(tool_name: string, tool_input: Record<string, string> = {}): HookInput {
  return { ...BASE, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' };
}

/** Which of the given matchers select a hook for the input; each hook has its own command. */
function selected(event: string, matchers: (string | undefined)[], input: HookInput) {
  const hooks = matchers.map((matcher, i) => hook(event, { matcher, command: `hook-${i}` }));
  return selectHooks(hooks, input).map(({ matcher }) => matcher);
}

describe('selectHooks matchers', () => {
  it('runs absent, empty and star matchers on every occurrence', () => {
    expect(selected('PreToolUse', [undefined, '', '*', 'Edit'], toolCall('Bash'))).toEqual([
      undefined,
      '',
      '*',
    ]);
  });

  it('compares a list of names exactly', () => {
    const matchers = ['Bash ,  Edit', 'Edit|Bash', 'bash', 'as', 'Bash Edit', ',Bash,'];
    expect(selected('PreToolUse', matchers, toolCall('Bash'))).toEqual([
      'Bash ,  Edit',
      'Edit|Bash',
      ',Bash,',
    ]);
  });

  it('tests any other matcher as an unanchored, case-sensitive regex', () => {
    const matchers = ['B.sh', '^Bash$', 'Edit.*', 'b.sh', '(', 'mcp__.*'];
    expect(selected('PreToolUse', matchers, toolCall('Bash'))).toEqual(['B.sh', '^Bash$']);
    expect(selected('PreToolUse', ['Edit.*'], toolCall('NotebookEdit'))).toEqual(['Edit.*']);
  });

  it('reads legacy tool names in an exact or a regex matcher', () => {
    expect(selected('PreToolUse', ['Task', '^Task$', 'Agent', 'Bash'], toolCall('Agent'))).toEqual([
      'Task',
      '^Task$',
      'Agent',
    ]);
  });

  it('keeps StopFailure and FileChanged lists to letters, digits, _ and |', () => {
    const input: HookInput = { ...BASE, hook_event_name: 'StopFailure', error: 'rate_limit' };
    // A comma or a hyphen makes the matcher a regex, so `limit|x-y` finds `rate_limit`.
    const matchers = ['rate_limit|unknown', 'rate_limit, unknown', 'limit|x-y'];
    expect(selected('StopFailure', matchers, input)).toEqual(['rate_limit|unknown', 'limit|x-y']);
  });

  it('tests FileChanged against the base name of the file', () => {
    const input: HookInput = {
      ...BASE,
      hook_event_name: 'FileChanged',
      file_path: '/work/config/.envrc',
      event: 'change',
    };
    // `envrc` is an exact name, and `.envrc` a regex that finds it; `^` anchors at the base name.
    const matchers = ['.envrc', 'envrc', 'config', '.envrc|x', '^\\.envrc$', '^/work'];
    expect(selected('FileChanged', matchers, input)).toEqual(['.envrc', '.envrc|x', '^\\.envrc$']);
  });

  it('tests the field each event names', () => {
    const input: HookInput = {
      ...BASE,
      hook_event_name: 'SessionStart',
      source: 'resume',
      model: 'm',
    };
    expect(selected('SessionStart', ['startup', 'resume|clear'], input)).toEqual(['resume|clear']);
  });

  it('ignores the matcher where an event has none', () => {
    const prompt: HookInput = { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
    expect(selected('UserPromptSubmit', ['nothing', undefined], prompt)).toEqual([
      'nothing',
      undefined,
    ]);
  });

  it('selects a hook whose regex is too slow to decide, and keeps testing the others', () => {
    const slow = toolCall(`mcp__${'a'.repeat(40)}!`);
    expect(selected('PreToolUse', ['(a+)+$', 'mcp__a', 'b!', '!$'], slow)).toEqual([
      '(a+)+$',
      '!$',
    ]);
  });

  it('runs every group when the input lacks the field the matcher tests', () => {
    const input: HookInput = {
      ...BASE,
      hook_event_name: 'SubagentStart',
      agent_id: 'a',
      agent_type: 'Explore',
    };
    expect(selected('SubagentStart', ['Plan', 'Explore'], input)).toEqual(['Explore']);
    // Legacy tool names apply on every event, as in Claude.
    const agent: HookInput = { ...input, agent_type: 'Agent' };
    expect(selected('SubagentStart', ['Task', '^Task$', 'Agent'], agent)).toEqual([
      'Task',
      '^Task$',
      'Agent',
    ]);
    // A caller may send input whose matcher field is missing, as Claude itself can.
    const untyped: HookInput = JSON.parse('{"hook_event_name":"SubagentStart","agent_id":"a"}');
    expect(selected('SubagentStart', ['Plan'], untyped)).toEqual(['Plan']);
  });

  it('selects only hooks for the event', () => {
    expect(selectHooks([hook('PostToolUse')], toolCall('Bash'))).toEqual([]);
  });
});

describe('selectHooks de-duplication', () => {
  it('runs a handler defined in several settings files once, in the first place, with the last fields', () => {
    const first = hook('PreToolUse', {
      id: 'user',
      scope: 'user',
      file: '/home/me/.claude/settings.json',
      matcher: 'Bash',
      timeoutSec: 5,
    });
    const other = hook('PreToolUse', { id: 'project', command: './other.sh' });
    const last = hook('PreToolUse', {
      id: 'local',
      scope: 'local',
      file: '/work/.claude/settings.local.json',
      matcher: '^Bash$',
      timeoutSec: 30,
    });
    expect(selectHooks([first, other, last], toolCall('Bash')).map(({ id }) => id)).toEqual([
      'local',
      'project',
    ]);
  });

  it('keeps handlers apart whose if or exec form differs', () => {
    const hooks = [
      hook('PreToolUse', { id: 'a' }),
      hook('PreToolUse', { id: 'b', if: 'Bash' }),
      hook('PreToolUse', { id: 'c', command: './check.sh C' }),
      hook('PreToolUse', { id: 'd', args: ['C'] }),
    ];
    expect(selectHooks(hooks, toolCall('Bash')).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
