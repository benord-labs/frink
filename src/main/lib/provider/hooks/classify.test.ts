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
      'a variable Claude sets on some events',
      { command: 'echo A=1 >> "$CLAUDE_ENV_FILE"' },
      'inline shell script',
    ],
    [
      'a plugin variable written without braces, which Claude runs',
      { command: 'ls "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PLUGIN_DATA"' },
      'inline shell script',
    ],
    ['the "if" filter, carried as written', { command: 'lint-all', if: 'Bash(git *)' }, 'lint-all'],
    [
      'any other variable whose name holds CLAUDE',
      { command: 'curl -H "x: $MY_CLAUDE_TOKEN" -d "$CLAUDE_2FA" "$CLAUDE_PROJECT_DIR_BACKUP"' },
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
      'the program of an exec form',
      { command: '${CLAUDE_PLUGIN_DATA}/bin/hook', args: ['--fix'] },
      '${CLAUDE_PLUGIN_DATA}',
    ],
    [
      'an exec argument',
      { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hook.js'] },
      '${CLAUDE_PLUGIN_ROOT}',
    ],
    [
      'a shell command, once however often it is used',
      { command: 'node "${CLAUDE_PLUGIN_ROOT}/a.js" "${CLAUDE_PLUGIN_ROOT}/b.js"' },
      '${CLAUDE_PLUGIN_ROOT}',
    ],
    [
      'the program and an argument, once for both',
      { command: '${CLAUDE_PLUGIN_ROOT}/bin/hook', args: ['${CLAUDE_PLUGIN_ROOT}/conf'] },
      '${CLAUDE_PLUGIN_ROOT}',
    ],
  ])('refuses a plugin placeholder, as Claude does, in %s', (_name, fields, placeholder) => {
    expect(classify({ type: 'command', ...fields }, 'SessionStart').binding).toEqual(
      refusedFor(
        'provider-variable',
        `: it uses ${placeholder}, which Claude fills in only for a plugin's own hooks.`,
      ),
    );
  });

  it.each([
    ['prompt', 'prompt', 'asks Claude to judge a prompt, which is not supported by Frink yet'],
    ['agent', 'agent', 'starts a Claude verifier agent, which is not supported by Frink yet'],
    ['http', 'http', 'posts to a URL, which is not supported by Frink yet'],
    ['mcp_tool', 'mcp_tool', 'calls an MCP tool, which is not supported by Frink yet'],
    ['webhook', 'webhook', 'is a kind of handler Claude does not define'],
    ['constructor', 'constructor', 'is a kind of handler Claude does not define'],
    [' ', 'unknown', 'is a kind of handler Claude does not define'],
  ])('refuses a "%s" handler without judging its fields', (type, handlerType, what) => {
    const handler = { type, prompt: 'Is this safe?', url: 'https://example.com', async: true };
    expect(classify(handler)).toEqual({
      handlerType,
      label: `${handlerType} handler`,
      binding: refusedFor('handler-type', `: it ${what}.`),
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
    ['shell', 'powershell', 'field-unsupported', 'PowerShell, which is not supported by Frink yet'],
    ['shell', 'zsh', 'malformed', 'its shell is neither "bash" nor "powershell"'],
    ['if', 'Bash(git *)'],
    ['if', 5, 'malformed', 'its "if" is not text'],
    ['once', false],
    ['once', 'yes', 'malformed', 'its "once" is not true or false'],
    ['once', null, 'malformed', 'its "once" is not true or false'],
    ['async', false],
    ['async', true, 'async', 'it sets "async" to run in the background, which is not supported by'],
    ['async', 0, 'malformed', 'its "async" is not true or false'],
    ['asyncRewake', false],
    ['asyncRewake', true, 'async', 'in the background, which is not supported by Frink yet'],
    ['asyncRewake', null, 'malformed', 'its "asyncRewake" is not true or false'],
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

  it('carries the timeout and lists the fields Claude ignores for this hook', () => {
    const fields = { timeout: 30, statusMessage: 'Checking', once: true };
    expect(classify(command(fields))).toMatchObject({
      timeoutSec: 30,
      binding: {
        status: 'supported',
        ignored: [
          {
            field: 'statusMessage',
            reason: 'spinner text only; it changes nothing the hook decides',
          },
          {
            field: 'once',
            reason: 'Claude honours it only in skill frontmatter, not in a settings file',
          },
        ],
      },
    });
  });

  it('lists a PowerShell "shell" as ignored on a hook that has args, as Claude ignores it', () => {
    const execForm = command({ command: 'lint-all', args: [], shell: 'powershell' });
    expect(classify(execForm).binding).toEqual({
      status: 'supported',
      ignored: [{ field: 'shell', reason: 'a hook with args runs without a shell' }],
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
    const handler = command({
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.js" "${CLAUDE_PLUGIN_DATA}"',
      async: true,
      shell: 'powershell',
    });
    expect(codes(handler, 'Invented')).toEqual([
      'event-unsupported',
      'async',
      'field-unsupported',
      'provider-variable',
      'provider-variable',
    ]);
  });
});
