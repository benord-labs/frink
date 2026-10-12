import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  HookInventory,
  HookRegistration,
  HookSource,
} from '../../../../shared/types/hook-inventory';
import { frinkUserHome } from '../../platform/frink-home';
import { bindHooks } from './index';

const USER_FILE = path.join(frinkUserHome(), '.claude', 'settings.json');
const PROJECT_FILE = '/work/.claude/settings.json';

function hook(fields: Partial<HookRegistration> = {}): HookRegistration {
  return {
    id: 'project:PreToolUse:0:0',
    scope: 'project',
    file: PROJECT_FILE,
    event: 'PreToolUse',
    handlerType: 'command',
    label: 'check.sh',
    command: './check.sh',
    binding: { status: 'supported', ignored: [] },
    ...fields,
  };
}

function refused(detail: string, fields: Partial<HookRegistration> = {}): HookRegistration {
  return hook({
    binding: { status: 'refused', refusals: [{ code: 'malformed', detail }] },
    ...fields,
  });
}

function inventory(fields: Partial<HookInventory>): HookInventory {
  const sources: HookSource[] = [{ scope: 'project', file: PROJECT_FILE, status: 'read' }];
  return { rootPath: '/work', sources, disableAllHooks: false, registrations: [], ...fields };
}

describe('bindHooks', () => {
  it('runs no hooks when none are registered or all are disabled', () => {
    expect(bindHooks(inventory({}))).toEqual({ status: 'no-hooks' });
    const disabled = inventory({ disableAllHooks: true, registrations: [refused('bad')] });
    expect(bindHooks(disabled)).toEqual({ status: 'no-hooks' });
  });

  it('is ready with every registration when Frink can run them all', () => {
    const hooks = [
      hook(),
      hook({ id: 'b', matcher: 'Bash' }),
      hook({ event: 'PreModelSwitch', matcher: '*' }),
      hook({ event: 'PostModelSwitch', matcher: '' }),
      hook({ event: 'PostModelSwitch', matcher: '.*' }),
      // An empty filter filters nothing.
      hook({ id: 'c', if: '' }),
    ];
    expect(bindHooks(inventory({ registrations: hooks }))).toEqual({ status: 'ready', hooks });
  });

  it('blocks on an unreadable settings file, naming it from the home directory', () => {
    const sources: HookSource[] = [
      { scope: 'user', file: USER_FILE, status: 'invalid', detail: 'Unexpected token' },
      { scope: 'project', file: PROJECT_FILE, status: 'missing' },
    ];
    expect(bindHooks(inventory({ sources }))).toEqual({
      status: 'blocked',
      reasons: [
        'The Claude settings file ~/.claude/settings.json cannot be read: Unexpected token',
      ],
    });
  });

  it('names every hook Frink cannot run, and its file, malformed ones included', () => {
    const registrations = [
      refused('The PreToolUse hook "a.sh" cannot run in Frink: it has no command.'),
      hook(),
      refused('The Stop hook "b.sh" cannot run in Frink: it posts to a URL.', {
        event: 'Stop',
        file: USER_FILE,
      }),
    ];
    expect(bindHooks(inventory({ registrations }))).toEqual({
      status: 'blocked',
      reasons: [
        `The PreToolUse hook "a.sh" cannot run in Frink: it has no command. (${PROJECT_FILE})`,
        'The Stop hook "b.sh" cannot run in Frink: it posts to a URL. (~/.claude/settings.json)',
      ],
    });
  });

  it('blocks a hook with an if filter, on any event', () => {
    const registrations = [
      hook({ if: 'Bash(rm *)' }),
      hook({ event: 'Stop', label: 'stop.sh', if: 'Edit', file: USER_FILE }),
    ];
    expect(blockedReasons(inventory({ registrations }))).toEqual([
      `The PreToolUse hook "check.sh" cannot run in Frink: its "if" filter is not supported by Frink yet. (${PROJECT_FILE})`,
      'The Stop hook "stop.sh" cannot run in Frink: its "if" filter is not supported by Frink yet. (~/.claude/settings.json)',
    ]);
  });

  it('blocks a model switch hook whose matcher names a model', () => {
    const registrations = [
      hook({ event: 'PreModelSwitch', matcher: 'claude-haiku' }),
      hook({ event: 'PostModelSwitch', matcher: 'opus|sonnet' }),
    ];
    expect(blockedReasons(inventory({ registrations }))).toEqual([
      `The PreModelSwitch hook "check.sh" cannot run in Frink: its model matcher is not supported by Frink yet. (${PROJECT_FILE})`,
      `The PostModelSwitch hook "check.sh" cannot run in Frink: its model matcher is not supported by Frink yet. (${PROJECT_FILE})`,
    ]);
  });

  it('shows settings text without escape codes or invisible characters, capped whole', () => {
    const name = `\u001b[31mred\u001b[0m\u202eevil\u200b${'😀'.repeat(400)}`;
    const result = bindHooks(inventory({ registrations: [refused(name)] }));
    expect(result.status).toBe('blocked');
    const [reason] = result.status === 'blocked' ? result.reasons : [];
    expect(reason.startsWith('red evil 😀')).toBe(true);
    const shown = reason.slice(0, reason.indexOf('…'));
    expect(Array.from(shown)).toHaveLength(300);
    expect(shown.endsWith('😀')).toBe(true);
  });

  it('cleans the parse detail, the file path and the hook name it quotes', () => {
    const sources: HookSource[] = [
      {
        scope: 'project',
        file: '/work/\u001b[2J.claude/settings.json',
        status: 'invalid',
        detail: `Unexpected token \u202e${'x'.repeat(400)}`,
      },
    ];
    const [reason] = blockedReasons(inventory({ sources }));
    expect(reason).toBe(
      `The Claude settings file /work/.claude/settings.json cannot be read: Unexpected token  ${'x'.repeat(282)}…`,
    );
    const registrations = [hook({ if: 'Edit', label: '\u0007a\u200b.sh' })];
    expect(blockedReasons(inventory({ registrations }))[0]).toContain('hook " a .sh" cannot');
  });

  it('gives one reason per refusal, invalid files first', () => {
    const twice = hook({
      binding: {
        status: 'refused',
        refusals: [
          { code: 'async', detail: 'one' },
          { code: 'handler-type', detail: 'two' },
        ],
      },
    });
    const sources: HookSource[] = [
      { scope: 'project', file: PROJECT_FILE, status: 'invalid', detail: 'bad' },
    ];
    expect(blockedReasons(inventory({ sources, registrations: [twice] }))).toEqual([
      `The Claude settings file ${PROJECT_FILE} cannot be read: bad`,
      `one (${PROJECT_FILE})`,
      `two (${PROJECT_FILE})`,
    ]);
  });

  it('shows only the home directory itself as ~', () => {
    const sibling = `${frinkUserHome()}2/settings.json`;
    expect(blockedReasons(inventory({ registrations: [refused('x', { file: sibling })] }))).toEqual(
      [`x (${sibling})`],
    );
  });
});

function blockedReasons(given: HookInventory): string[] {
  const result = bindHooks(given);
  return result.status === 'blocked' ? result.reasons : [];
}
