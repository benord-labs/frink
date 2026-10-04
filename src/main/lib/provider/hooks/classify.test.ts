import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { classifyHook } from './classify';

const knownEvents = new Set<string>(HOOK_EVENTS);

function classify(handler: unknown, event = 'PreToolUse', extraGroupKeys: string[] = []) {
  return classifyHook({ event, knownEvents, extraGroupKeys, handler });
}

/** The refusal codes of a handler; empty when it is supported. */
function codes(handler: unknown, event?: string): string[] {
  const { binding } = classify(handler, event);
  return binding.status === 'refused' ? binding.refusals.map((refusal) => refusal.code) : [];
}

/** The binding of a hook refused for one reason whose sentence contains `text`. */
function refusedFor(code: string, text: string) {
  return { status: 'refused', refusals: [{ code, detail: expect.stringContaining(text) }] };
}

function command(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'command', command: 'lint-all --staged', ...extra };
}

describe('classifyHook', () => {
  it.each<[string, Record<string, unknown>, string]>([
    [
      'the exec form',
      { command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/check-style.sh', args: ['--fix'] },
      'check-style.sh',
    ],
    [
      'the exec form with the script as an argument',
      { command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/x.mjs', '--fix'] },
      'x.mjs',
    ],
    [
      'a shell form that quotes only the placeholder',
      { command: 'node "${CLAUDE_PROJECT_DIR}"/.claude/hooks/x.mjs --fix' },
      'x.mjs',
    ],
    [
      'a fully quoted script path',
      { command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/gate.mjs"' },
      'gate.mjs',
    ],
    ['the exec form with an empty argument list', { command: 'lint-all', args: [] }, 'lint-all'],
    ['a program with no Claude variable', { command: 'lint-all --staged' }, 'lint-all'],
    ['a program after a leading space', { command: ' lint-all --staged' }, 'lint-all'],
    ['a relative script', { command: './scripts/check.sh' }, 'check.sh'],
    ['a script path that runs into shell text', { command: '$CLAUDE_PROJECT_DIR/x.sh;ls' }, 'x.sh'],
    [
      'a variable that only contains the Claude prefix',
      { command: 'curl -H "x: $MY_CLAUDE_TOKEN" https://example.com' },
      'inline shell script',
    ],
    [
      'a lookalike variable with a lowercase suffix',
      { command: 'echo "$CLAUDE_foo"' },
      'inline shell script',
    ],
  ])('supports %s as written', (_name, fields, label) => {
    expect(classify({ type: 'command', ...fields })).toEqual({
      handlerType: 'command',
      label,
      ...fields,
      binding: { status: 'supported', ignored: [] },
    });
  });

  it('supports every event the SDK knows and refuses any other name', () => {
    expect(HOOK_EVENTS).toContain('SessionStart');
    expect(HOOK_EVENTS.flatMap((event) => codes(command(), event))).toEqual([]);
    expect(classify(command(), 'PreToolUsed').binding).toEqual({
      status: 'refused',
      refusals: [
        {
          code: 'event-unsupported',
          detail:
            'The PreToolUsed hook "lint-all" cannot run in Frink: Frink does not know that hook event.',
        },
      ],
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'its command, twice',
      { command: 'echo A=1 >> "$CLAUDE_ENV_FILE"; cat "$CLAUDE_ENV_FILE"' },
      'CLAUDE_ENV_FILE',
    ],
    [
      'the program of an exec form',
      { command: '${CLAUDE_PLUGIN_DATA}/bin/hook', args: ['--fix'] },
      'CLAUDE_PLUGIN_DATA',
    ],
    [
      'an exec argument',
      { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hook.js'] },
      'CLAUDE_PLUGIN_ROOT',
    ],
    [
      'a longer name that starts like the project variable',
      { command: 'node "$CLAUDE_PROJECT_DIR_BACKUP/x.mjs"' },
      'CLAUDE_PROJECT_DIR_BACKUP',
    ],
    ['a name with a digit', { command: 'echo "$CLAUDE_2FA"' }, 'CLAUDE_2FA'],
    [
      'a command that also names a lowercase lookalike',
      { command: 'echo "$CLAUDE_foo" >> "$CLAUDE_ENV_FILE"' },
      'CLAUDE_ENV_FILE',
    ],
  ])('refuses a hook that uses a provider-only variable in %s', (_name, fields, variable) => {
    expect(classify({ type: 'command', ...fields }, 'SessionStart').binding).toEqual(
      refusedFor('provider-variable', `it uses ${variable}, which only Claude provides.`),
    );
  });

  it.each([
    ['prompt', 'prompt', 'asks Claude to judge a prompt'],
    ['agent', 'agent', 'starts a Claude verifier agent'],
    ['http', 'http', 'posts to a URL'],
    ['mcp_tool', 'mcp_tool', 'calls an MCP tool'],
    ['webhook', 'webhook', 'is a kind Frink does not know'],
    ['constructor', 'constructor', 'is a kind Frink does not know'],
    [' ', 'unknown', 'is a kind Frink does not know'],
  ])('refuses a "%s" handler without judging its fields', (type, handlerType, what) => {
    const handler = { type, prompt: 'Is this safe?', url: 'https://example.com', async: true };
    expect(classify(handler)).toEqual({
      handlerType,
      label: `${handlerType} handler`,
      binding: refusedFor('handler-type', `: it ${what}, and Frink only runs command hooks.`),
    });
  });

  // A row with no code is a supported value.
  it.each<[string, unknown, string?, string?]>([
    ['timeout', 5],
    ['timeout', '5', 'malformed', 'its timeout is not a positive number of seconds'],
    ['timeout', 0, 'malformed', 'its timeout is not a positive number of seconds'],
    ['timeout', -1, 'malformed', 'its timeout is not a positive number of seconds'],
    ['timeout', Infinity, 'malformed', 'its timeout is not a positive number of seconds'],
    ['shell', 'bash'],
    ['shell', 'powershell', 'field-unsupported', 'it sets "shell": Frink runs hooks with a POSIX'],
    ['if', 'Bash(git *)', 'field-unsupported', 'it sets "if", a filter Frink cannot evaluate'],
    ['once', false],
    ['once', true, 'field-unsupported', 'it sets "once": Frink does not track run-once hooks'],
    ['once', null, 'field-unsupported', 'it sets "once": Frink does not track run-once hooks'],
    ['async', false],
    ['async', true, 'async', 'it sets "async": a background hook cannot gate anything'],
    ['async', 0, 'async', 'it sets "async": a background hook cannot gate anything'],
    ['asyncRewake', false],
    ['asyncRewake', true, 'async', 'it sets "asyncRewake": a background hook cannot gate'],
    ['asyncRewake', null, 'async', 'it sets "asyncRewake": a background hook cannot gate'],
    ['statusMessage', 5, 'malformed', 'its statusMessage is not text'],
    ['args', '--fix', 'malformed', 'its args are not a list of strings'],
    ['args', ['--fix', 1], 'malformed', 'its args are not a list of strings'],
    ['retries', false, 'field-unknown', 'it sets "retries", which Frink does not know'],
    ['constructor', 'x', 'field-unknown', 'it sets "constructor", which Frink does not know'],
  ])('decides the command field %s = %s', (field, value, code, text = '') => {
    expect(classify(command({ [field]: value })).binding).toEqual(
      code ? refusedFor(code, text) : { status: 'supported', ignored: [] },
    );
  });

  it('names every unknown handler or group key instead of dropping it', () => {
    const start = 'The Stop hook "lint-all" cannot run in Frink:';
    expect(classify(command({ retries: 2 }), 'Stop', ['description', 'note']).binding).toEqual({
      status: 'refused',
      refusals: [
        `${start} its matcher group sets "description", which Frink does not know.`,
        `${start} its matcher group sets "note", which Frink does not know.`,
        `${start} it sets "retries", which Frink does not know.`,
      ].map((detail) => ({ code: 'field-unknown', detail })),
    });
  });

  it('carries the timeout and lists the status message as ignored', () => {
    expect(classify(command({ timeout: 30, statusMessage: 'Checking' }))).toMatchObject({
      timeoutSec: 30,
      binding: {
        status: 'supported',
        ignored: [
          {
            field: 'statusMessage',
            reason: 'spinner text only; it changes nothing the hook decides',
          },
        ],
      },
    });
  });

  it.each<[string, unknown, string, string]>([
    ['is not an object', 'lint-all --staged', 'unknown', 'it has no handler type'],
    ['is null', null, 'unknown', 'it has no handler type'],
    ['has a type that is not text', { type: 5 }, 'unknown', 'it has no handler type'],
    ['has no type', { command: 'lint-all --staged' }, 'unknown', 'it has no handler type'],
    ['has no command', { type: 'command' }, 'command', 'it has no command'],
    ['has a blank command', { type: 'command', command: '  ' }, 'command', 'it has no command'],
  ])('reports a handler that %s as malformed', (_name, handler, handlerType, reason) => {
    expect(classify(handler)).toMatchObject({
      handlerType,
      label: `${handlerType} handler`,
      binding: refusedFor('malformed', reason),
    });
  });

  it('keeps the command and a valid timeout on a refused hook', () => {
    expect(classify(command({ timeout: 30, async: true }))).toEqual({
      handlerType: 'command',
      label: 'lint-all',
      command: 'lint-all --staged',
      timeoutSec: 30,
      binding: refusedFor('async', 'it sets "async"'),
    });
  });

  it('carries neither a timeout nor args that it refused', () => {
    const refused = classify(command({ timeout: 0, args: ['--fix', 1] }));
    expect(refused.command).toBe('lint-all --staged');
    expect(refused).not.toHaveProperty('timeoutSec');
    expect(refused).not.toHaveProperty('args');
  });

  it('collects every refusal on one hook', () => {
    const handler = command({ command: 'cat "$CLAUDE_ENV_FILE"', async: true, if: 'Bash(git *)' });
    expect(codes(handler, 'Invented')).toEqual([
      'event-unsupported',
      'async',
      'field-unsupported',
      'provider-variable',
    ]);
  });
});
