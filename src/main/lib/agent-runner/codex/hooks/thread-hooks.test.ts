import { describe, expect, it } from 'vitest';
import { codexThreadHooks } from './thread-hooks';

const KEY = '/<session-flags>/config.toml';
type CommandFields = { timeout?: number; async?: boolean; statusMessage?: string };
const command = (line: string, extra: CommandFields = {}) => ({
  type: 'command' as const,
  command: line,
  ...extra,
});

const LABELS = new Map([
  ['Stop', 'stop'],
  ['PreToolUse', 'pre_tool_use'],
  ['SessionEnd', 'session_end'],
  ['UserPromptSubmit', 'user_prompt_submit'],
]);

// Hashes the bundled Codex app-server (0.155.1) reported for these hooks via `hooks/list`.
describe('the hash Codex trusts a delivered hook by', () => {
  it.each([
    [
      'Stop',
      undefined,
      { command: 'echo stop' },
      '236335e9e512004a0f5f42af65a07ea9059bd9a23dbb68286ed57fecf2b69ddf',
    ],
    [
      'PreToolUse',
      'Bash',
      { command: 'echo pre', timeout: 30, statusMessage: 'Checking' },
      'ca3fb0dd8fd150b3e39e8573e366b266a504e5385223ff57ad52efd47c22405e',
    ],
    [
      'PreToolUse',
      'Bash',
      { command: 'echo pre2', async: true },
      '4432f67f12bcda663c413892ea69dad4b6cdd6afd462ef55aab663d7eb08f828',
    ],
    [
      'SessionEnd',
      undefined,
      { command: 'echo end', timeout: 10 },
      '84be7971dba2dbb128add226e0537c753853bf675df8efb85a5dcbb611374b4f',
    ],
    [
      'UserPromptSubmit',
      'ignored',
      { command: 'echo ups' },
      '9c4ab9d6e10ed8234dcda93f0586d119be57dcd3f988d610c58b2f9d127f6564',
    ],
    [
      'PreToolUse',
      '',
      { command: 'echo "quoted" \\ back\ttab\nnewline ünïcødé 🚀 </>&\'' },
      '789e2b33b0f49108154bd732991e4185b68b862d1c49051697adae7ce71e5c2b',
    ],
    [
      'PreToolUse',
      '*',
      { command: 'exit 0', timeout: 0 },
      '6a967bb9cd266002fd9a11f9dbe9a0e42af8a58f8ab1fd0ae362d8c21c43e96f',
    ],
  ])('%s %j %j', (event, matcher, { command: line, ...fields }, hash) => {
    const hooks = codexThreadHooks({ [event]: [{ matcher, hooks: [command(line, fields)] }] });

    expect(hooks?.state).toEqual({
      [`${KEY}:${LABELS.get(event)}:0:0`]: { trusted_hash: `sha256:${hash}`, enabled: true },
    });
  });
});

describe("a Codex thread's hooks table", () => {
  it('marks each delivered handler trusted under the key of its position', () => {
    const hooks = codexThreadHooks({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [command('echo pre', { timeout: 30, statusMessage: 'Checking' })],
        },
        { matcher: '*', hooks: [command('exit 0', { timeout: 0 })] },
      ],
    });

    expect(hooks).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [command('echo pre', { timeout: 30, statusMessage: 'Checking' })],
        },
        { matcher: '*', hooks: [command('exit 0', { timeout: 0 })] },
      ],
      state: {
        [`${KEY}:pre_tool_use:0:0`]: {
          trusted_hash: 'sha256:ca3fb0dd8fd150b3e39e8573e366b266a504e5385223ff57ad52efd47c22405e',
          enabled: true,
        },
        [`${KEY}:pre_tool_use:1:0`]: {
          trusted_hash: 'sha256:6a967bb9cd266002fd9a11f9dbe9a0e42af8a58f8ab1fd0ae362d8c21c43e96f',
          enabled: true,
        },
      },
    });
  });

  it("puts the user's Stop hooks after Frink's own, keyed from there", () => {
    const guard = {
      hooks: [
        {
          type: 'mcp_tool' as const,
          server: 'frink',
          tool: 'guard',
          input: { stop_hook_active: 'true' },
          timeout: 5,
        },
      ],
    };

    const hooks = codexThreadHooks(
      { Stop: [{ hooks: [command('echo stop')] }] },
      { Stop: [guard] },
    );

    expect(hooks).toMatchObject({ Stop: [guard, { hooks: [command('echo stop')] }] });
    expect(Object.keys(hooks?.state ?? {})).toEqual([`${KEY}:stop:1:0`]);
  });

  it('leaves out what Codex cannot run as written: other events, handler types, filters', () => {
    // A field Claude may add later, which this code does not know the meaning of.
    const laterField = { ...command('later-field'), rewakeSummary: 'later' };
    const hooks = codexThreadHooks({
      Notification: [{ hooks: [command('say hi')] }],
      PostToolUse: [
        {
          hooks: [
            { type: 'prompt', prompt: 'check it' },
            { type: 'http', url: 'https://example.test' },
            { ...command('commit-check'), if: 'Bash(git commit*)' },
            { ...command('exec-form'), args: ['--fast'] },
            { ...command('wake-on-fail'), asyncRewake: true },
            laterField,
            command('lint', { timeout: 1.5 }),
          ],
        },
      ],
    });

    expect(hooks).toEqual({
      PostToolUse: [{ hooks: [{ type: 'command', command: 'lint', timeout: 2 }] }],
      state: { [`${KEY}:post_tool_use:0:0`]: expect.objectContaining({ enabled: true }) },
    });
  });

  it('refuses a handler whose field has the wrong type, as a hand-edited file can hold', () => {
    const handlers = [
      { type: 'command', command: 'text-async', async: 'true' },
      { type: 'command', command: 'text-timeout', timeout: '30' },
    ];
    // Parsed JSON, as the settings file reaches Frink before any type applies.
    const userHooks: Parameters<typeof codexThreadHooks>[0] = JSON.parse(
      JSON.stringify({ Stop: [{ hooks: handlers }] }),
    );

    expect(codexThreadHooks(userHooks)).toBeUndefined();
  });

  it('is absent when there is nothing to deliver', () => {
    expect(codexThreadHooks(undefined)).toBeUndefined();
    expect(codexThreadHooks({ Notification: [{ hooks: [command('say hi')] }] })).toBeUndefined();
  });
});
