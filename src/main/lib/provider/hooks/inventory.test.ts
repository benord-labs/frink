import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookInventory, HookScope } from '../../../../shared/types/hook-inventory';
import { DEFAULT_WORKTREE_BASE_PATH } from '../../worktree/base-path-config';
import { readHookInventory } from './index';

type RawSettings = { hooks: Record<string, { hooks: unknown[]; [key: string]: unknown }[]> };

function hook(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'command', command, ...extra };
}

const PLAIN = hook('lint-all --staged');
const GUARDED_SCRIPT = '${CLAUDE_PROJECT_DIR}/.claude/tools/notify.mjs';
const GUARDED = `[ ! -f "${GUARDED_SCRIPT}" ] || node "${GUARDED_SCRIPT}"`;

// Made-up settings in the shapes real files take: two handlers in a group, two groups on an
// event, and a matcher that is absent, empty or an alternation.
const projectSettings: RawSettings = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [hook('node "$CLAUDE_PROJECT_DIR/.claude/hooks/check-search.mjs"'), PLAIN],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Bash|Read',
        hooks: [hook('node "$CLAUDE_PROJECT_DIR/.claude/hooks/count.mjs"')],
      },
    ],
  },
};
const localSettings: RawSettings = {
  hooks: {
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          hook(GUARDED, { timeout: 5, statusMessage: 'Checking changes' }),
          hook('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/format.sh"'),
        ],
      },
      {
        matcher: 'Task',
        hooks: [hook('node "$CLAUDE_PROJECT_DIR/.claude/hooks/notify.mjs"')],
      },
    ],
    Stop: [
      { hooks: [hook(GUARDED, { timeout: 30, statusMessage: 'Final pass' })] },
      {
        matcher: '',
        hooks: [hook('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/check-style.sh"')],
      },
    ],
    UserPromptSubmit: [
      { matcher: '', hooks: [hook('node "$CLAUDE_PROJECT_DIR/.claude/hooks/remind.mjs"')] },
    ],
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [hook('node "$CLAUDE_PROJECT_DIR/.claude/hooks/greet.mjs"')],
      },
    ],
    PreCompact: [
      { matcher: '', hooks: [hook('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/summarise.sh"')] },
    ],
  },
};

// Stand-in for a third-party wrapper that one machine registers on thirteen events.
const WRAPPER = hook('h="${HOME-}/.wrapper/hook"; "$h"; true', { timeout: 10 });
// It sets a catch-all matcher on four events and none on the other nine.
const USER_MATCHED = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
const USER_UNMATCHED = [
  ...['UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop'],
  ...['TeammateIdle', 'SessionStart', 'PostCompact', 'SessionEnd'],
];
const userSettings: RawSettings = {
  hooks: Object.fromEntries([
    ...USER_MATCHED.map((event) => [event, [{ matcher: '*', hooks: [WRAPPER] }]]),
    ...USER_UNMATCHED.map((event) => [event, [{ hooks: [WRAPPER] }]]),
  ]),
};
/** Marks the table row whose settings path is a directory. */
const UNREADABLE = Symbol('unreadable');

let dir: string;
let home: string;
let root: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook inventory '));
  home = path.join(dir, 'home');
  root = path.join(dir, 'my repo');
  vi.stubEnv('FRINK_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

function settingsFile(scope: HookScope): string {
  const name = scope === 'local' ? 'settings.local.json' : 'settings.json';
  return path.join(scope === 'user' ? home : root, '.claude', name);
}

async function writeSettings(scope: HookScope, content: unknown): Promise<void> {
  await fs.mkdir(path.dirname(settingsFile(scope)), { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  await fs.writeFile(settingsFile(scope), text);
}

/** Handlers in raw settings JSON, counted without the reader. */
function handlerCount(settings: RawSettings): number {
  return Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks))
    .length;
}

function countByScope({ registrations }: HookInventory): Record<HookScope, number> {
  const counts = { user: 0, project: 0, local: 0 };
  for (const { scope } of registrations) counts[scope] += 1;
  return counts;
}

function matcherOf({ registrations }: HookInventory, id: string): string | undefined {
  return registrations.find((hook) => hook.id === id)?.matcher;
}

/** Each registration's verdict by id: 'supported' or its refusal codes. */
function verdicts({ registrations }: HookInventory): Record<string, string | string[]> {
  return Object.fromEntries(
    registrations.map(({ id, binding }) => [
      id,
      binding.status === 'refused' ? binding.refusals.map((refusal) => refusal.code) : 'supported',
    ]),
  );
}

describe('readHookInventory', () => {
  it('lists every hook of three settings files, and all are supported', async () => {
    await writeSettings('user', userSettings);
    await writeSettings('project', projectSettings);
    await writeSettings('local', localSettings);
    const inventory = await readHookInventory(root);
    const written = {
      user: handlerCount(userSettings),
      project: handlerCount(projectSettings),
      local: handlerCount(localSettings),
    };

    expect(inventory.sources.map((source) => source.status)).toEqual(['read', 'read', 'read']);
    expect(written).toEqual({ user: 13, project: 3, local: 8 });
    expect(countByScope(inventory)).toEqual(written);
    expect(
      inventory.registrations.filter((hook) => hook.file !== settingsFile(hook.scope)),
    ).toEqual([]);
    expect(Object.values(verdicts(inventory)).filter((verdict) => verdict !== 'supported')).toEqual(
      [],
    );
    expect(inventory.registrations.find((hook) => hook.id === 'project:PreToolUse:0:1')).toEqual({
      id: 'project:PreToolUse:0:1',
      scope: 'project',
      file: settingsFile('project'),
      event: 'PreToolUse',
      matcher: 'Bash',
      handlerType: 'command',
      label: 'lint-all',
      command: 'lint-all --staged',
      binding: { status: 'supported', ignored: [] },
    });
    // As written: no matcher, an empty matcher and a catch-all stay three different things.
    expect(matcherOf(inventory, 'local:Stop:0:0')).toBeUndefined();
    expect(matcherOf(inventory, 'local:Stop:1:0')).toBe('');
    expect(matcherOf(inventory, 'user:PreToolUse:0:0')).toBe('*');
    expect(matcherOf(inventory, 'local:PostToolUse:0:1')).toBe('Edit|Write');
    const withIgnored = inventory.registrations.filter(
      ({ binding }) => binding.status === 'supported' && binding.ignored.length > 0,
    );
    expect(withIgnored.map((hook) => [hook.id, hook.label, hook.timeoutSec])).toEqual([
      ['local:PostToolUse:0:0', 'notify.mjs', 5],
      ['local:Stop:0:0', 'notify.mjs', 30],
    ]);
  });

  it('supports a command hook on every event the SDK knows', async () => {
    const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [PLAIN] }]]));
    await writeSettings('project', { hooks });

    expect(HOOK_EVENTS.length).toBeGreaterThan(6);
    expect(verdicts(await readHookInventory(root))).toEqual(
      Object.fromEntries(HOOK_EVENTS.map((event) => [`project:${event}:0:0`, 'supported'])),
    );
  });

  it('turns every handler into one registration, refused or not', async () => {
    const mixed: RawSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              PLAIN,
              { type: 'prompt', prompt: 'Is this safe?' },
              'lint-all --staged',
              { ...PLAIN, timeout: '5' },
            ],
          },
          { hooks: [] },
          { matcher: 'Edit', description: 'style', hooks: [PLAIN] },
        ],
        Invented: [{ hooks: [PLAIN] }],
        SessionStart: [
          {
            hooks: [
              { type: 'http', url: 'https://example.com/hook' },
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.js"' },
            ],
          },
        ],
      },
    };
    await writeSettings('project', { env: { A: '1' }, permissions: { allow: [] }, ...mixed });
    const inventory = await readHookInventory(root);

    expect(inventory.registrations).toHaveLength(handlerCount(mixed));
    expect(verdicts(inventory)).toEqual({
      'project:PreToolUse:0:0': 'supported',
      'project:PreToolUse:0:1': ['handler-type'],
      'project:PreToolUse:0:2': ['malformed'],
      'project:PreToolUse:0:3': ['malformed'],
      'project:PreToolUse:2:0': ['field-unknown'],
      'project:Invented:0:0': ['event-unsupported'],
      'project:SessionStart:0:0': ['handler-type'],
      'project:SessionStart:0:1': ['provider-variable'],
    });
  });

  it('reads the root checkout when given a worktree path', async () => {
    const worktree = path.join(dir, 'worktrees', 'my-repo', 'chat-1');
    await writeSettings('project', projectSettings);
    const inventory = await readHookInventory(worktree, (given) =>
      given === worktree ? root : given,
    );

    expect(inventory.rootPath).toBe(root);
    expect(countByScope(inventory)).toEqual({ user: 0, project: 3, local: 0 });
  });

  // The real resolver needs the app database, which tests cannot open, so it resolves nothing.
  it('fails loudly when the real resolver cannot resolve a Frink worktree', async () => {
    const worktree = path.join(DEFAULT_WORKTREE_BASE_PATH, 'my-repo', 'chat-1');
    await expect(readHookInventory(worktree)).rejects.toThrow(
      `Cannot resolve the root checkout of ${worktree}`,
    );
  });

  it('reads a blank file and a leading byte-order mark the way Claude does', async () => {
    await writeSettings('user', `\uFEFF${JSON.stringify(projectSettings)}`);
    await writeSettings('project', '');
    await writeSettings('local', ' \n');
    const inventory = await readHookInventory(root);

    expect(inventory.sources.map((source) => source.status)).toEqual(['read', 'read', 'read']);
    expect(countByScope(inventory)).toEqual({ user: 3, project: 0, local: 0 });
  });

  it('reports absent settings files as missing, not as an error', async () => {
    expect(await readHookInventory(root)).toEqual({
      rootPath: root,
      sources: [
        { scope: 'user', file: settingsFile('user'), status: 'missing' },
        { scope: 'project', file: settingsFile('project'), status: 'missing' },
        { scope: 'local', file: settingsFile('local'), status: 'missing' },
      ],
      disableAllHooks: false,
      registrations: [],
    });
  });

  it.each<[string, unknown, RegExp]>([
    ['invalid JSON', '{ "hooks": ', /JSON/],
    ['text that starts with a no-break space', '\u00A0{}', /JSON/],
    ['two leading byte-order marks', '\uFEFF\uFEFF{}', /JSON/],
    ['a file that is not an object', [], /^Invalid input/],
    ['an event that is not a list of groups', { hooks: { Stop: { hooks: [] } } }, /^hooks\.Stop: /],
    ['a group with no handler list', { hooks: { Stop: [{ matcher: '' }] } }, /^hooks\.Stop\.0\./],
    ['a matcher that is not text', { hooks: { Stop: [{ matcher: 1, hooks: [] }] } }, /matcher: /],
    ['a flag that is not a boolean', { disableAllHooks: 'yes' }, /^disableAllHooks: /],
    ['an event key that would be dropped', '{"hooks":{"__proto__":[]}}', /"__proto__"/],
    ['a group key that would be dropped', '{"hooks":{"Stop":[{"__proto__":1}]}}', /"__proto__"/],
    ['a file that cannot be read', UNREADABLE, /EISDIR/],
  ])('reports %s as an invalid file without hiding the others', async (_name, content, detail) => {
    await writeSettings('user', userSettings);
    if (content === UNREADABLE) await fs.mkdir(settingsFile('project'), { recursive: true });
    else await writeSettings('project', content);
    await writeSettings('local', projectSettings);
    const inventory = await readHookInventory(root);

    expect(inventory.sources.map((source) => source.status)).toEqual(['read', 'invalid', 'read']);
    expect(inventory.sources[1].detail).toMatch(detail);
    expect(countByScope(inventory)).toEqual({ user: 13, project: 0, local: 3 });
  });

  it('keeps an invalid file visible when another file turns all hooks off', async () => {
    await writeSettings('user', { ...userSettings, disableAllHooks: true });
    await writeSettings('local', '{');
    const inventory = await readHookInventory(root);

    expect(inventory.sources.map((source) => source.status)).toEqual([
      'read',
      'missing',
      'invalid',
    ]);
    expect(inventory.disableAllHooks).toBe(false);
    expect(countByScope(inventory)).toEqual({ user: 13, project: 0, local: 0 });
  });

  // An undefined flag is left out of the written file.
  it.each<[Partial<Record<HookScope, boolean | undefined>>, boolean]>([
    [{ user: true, project: undefined }, true],
    [{ user: true, local: false }, false],
    [{ user: false, project: true }, true],
    [{ local: true }, true],
  ])('takes disableAllHooks from the last file that sets it: %j', async (flags, expected) => {
    for (const [scope, disableAllHooks] of Object.entries(flags)) {
      await writeSettings(scope as HookScope, { ...projectSettings, disableAllHooks });
    }
    const inventory = await readHookInventory(root);

    expect(inventory.disableAllHooks).toBe(expected);
    // The flag is reported, not applied: the hooks are still listed.
    expect(inventory.registrations).toHaveLength(3 * Object.keys(flags).length);
  });

  it('lists the home settings once when the project is the home, however each is written', async () => {
    await writeSettings('user', projectSettings);
    vi.stubEnv('FRINK_HOME', path.relative(process.cwd(), home));
    const inventory = await readHookInventory(`${home}${path.sep}nested${path.sep}..${path.sep}`);

    expect(inventory.rootPath).toBe(home);
    expect(inventory.sources.map((source) => source.scope)).toEqual(['user', 'local']);
    expect(countByScope(inventory)).toEqual({ user: 3, project: 0, local: 0 });
  });
});
