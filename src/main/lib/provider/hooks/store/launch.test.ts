import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitAsTestUser as git } from '../../../test-utils/git-as-test-user';
import {
  _resetHooksLockForTests,
  checkClaudeHooksLock,
  claudeHooksForLaunch,
  hooksForLaunch,
  takeHooksLockNotice,
} from './launch';
import * as pluginLock from './plugin-lock';
import { syncHookStore } from './store';

type SettingsFile = { hooks?: object; disableAllHooks?: boolean; model?: string };

const stopHook = (command: string) => ({ Stop: [{ hooks: [{ type: 'command', command }] }] });

describe('the hook store and what each provider is handed at launch', () => {
  let home: string;
  let repo: string;
  const userFile = () => path.join(home, '.claude', 'settings.json');
  const storeFile = () => path.join(home, '.frink', 'hooks', 'hooks.json');
  const writeText = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const write = (file: string, settings: SettingsFile) => writeText(file, JSON.stringify(settings));
  const readStore = () => JSON.parse(fs.readFileSync(storeFile(), 'utf8'));

  beforeEach(() => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frink-hook-store-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(home);
    git(tmp, 'init', '-q', repo);
    vi.stubEnv('FRINK_HOME', home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  });

  it("hands Claude the user's hooks and keeps a fingerprinted copy in ~/.frink/hooks", async () => {
    write(userFile(), { hooks: stopHook('notify'), model: 'opus' });

    expect(await hooksForLaunch('claude-code', null)).toEqual({ hooks: stopHook('notify') });
    expect(readStore().sources).toMatchObject({
      [userFile()]: {
        scope: 'user',
        hooks: stopHook('notify'),
        baseline: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it('pulls back an edit to the native file and drops hooks the file no longer has', async () => {
    write(userFile(), { hooks: stopHook('notify') });
    await hooksForLaunch('claude-code', null);

    write(userFile(), { hooks: stopHook('chime') });
    expect(await hooksForLaunch('claude-code', null)).toEqual({ hooks: stopHook('chime') });

    fs.rmSync(userFile());
    expect(await hooksForLaunch('claude-code', null)).toEqual({});
    expect(readStore().sources).toEqual({});
  });

  it('keeps the last imported hooks while the native file cannot be read', async () => {
    write(userFile(), { hooks: stopHook('notify') });
    await hooksForLaunch('claude-code', null);

    writeText(userFile(), '{ not json');

    expect(await hooksForLaunch('claude-code', null)).toEqual({ hooks: stopHook('notify') });
  });

  it("imports a project's committed settings file as well as its local one", async () => {
    const committed = path.join(repo, '.claude', 'settings.json');
    const local = path.join(repo, '.claude', 'settings.local.json');
    write(committed, { hooks: stopHook('committed') });
    git(repo, 'add', '.claude/settings.json');
    write(local, { hooks: stopHook('gate') });

    const store = await syncHookStore(repo);

    expect(store.sources).toMatchObject({
      [committed]: { scope: 'project', projectRoot: repo, hooks: stopHook('committed') },
      [local]: { scope: 'project', projectRoot: repo, hooks: stopHook('gate') },
    });
  });

  it("drops a project's entry once its file is removed or holds no hooks", async () => {
    const committed = path.join(repo, '.claude', 'settings.json');
    const local = path.join(repo, '.claude', 'settings.local.json');
    write(committed, { hooks: stopHook('committed') });
    write(local, { hooks: stopHook('gate') });
    await syncHookStore(repo);

    fs.rmSync(local);
    write(committed, { model: 'opus' });

    expect((await syncHookStore(repo)).sources).toEqual({});
  });

  it('re-imports from the native file when the store holds a malformed group', async () => {
    write(userFile(), { hooks: stopHook('notify') });
    await hooksForLaunch('codex', null);
    const store = readStore();
    store.sources[userFile()].hooks = { Stop: [{}] };
    writeText(storeFile(), JSON.stringify(store));

    expect(await hooksForLaunch('codex', null)).toEqual({ hooks: stopHook('notify') });
  });

  it('hands over an event whose name is also an Object.prototype member', async () => {
    const hooks = { constructor: [{ hooks: [{ type: 'command', command: 'odd' }] }] };
    write(userFile(), { hooks });

    expect(await hooksForLaunch('codex', null)).toEqual({ hooks });
  });

  it('imports the settings of a project folder that is not a git repo', async () => {
    const folder = path.join(path.dirname(repo), 'plain');
    write(path.join(folder, '.claude', 'settings.local.json'), { hooks: stopHook('gate') });

    expect(await hooksForLaunch('codex', folder)).toEqual({ hooks: stopHook('gate') });
  });

  it('still hands over the hooks it read when the store cannot be saved', async () => {
    writeText(path.join(home, '.frink'), 'not a folder');
    write(userFile(), { hooks: stopHook('notify') });

    expect(await hooksForLaunch('claude-code', null)).toEqual({ hooks: stopHook('notify') });
  });

  it("hands Claude the user's hooks, then both of the project's files, in Claude's order", async () => {
    write(userFile(), { hooks: stopHook('notify') });
    write(path.join(repo, '.claude', 'settings.local.json'), { hooks: stopHook('local') });
    write(path.join(repo, '.claude', 'settings.json'), { hooks: stopHook('committed') });

    const launch = await hooksForLaunch('claude-code', repo);

    expect(launch.hooks?.Stop?.flatMap((group) => group.hooks)).toEqual([
      { type: 'command', command: 'notify' },
      { type: 'command', command: 'committed' },
      { type: 'command', command: 'local' },
    ]);
  });

  it("hands Codex the user's hooks, then this project's, never another's", async () => {
    const other = path.join(path.dirname(repo), 'other');
    git(path.dirname(repo), 'init', '-q', other);
    write(path.join(repo, '.claude', 'settings.local.json'), { hooks: stopHook('gate') });
    write(path.join(other, '.claude', 'settings.local.json'), { hooks: stopHook('elsewhere') });
    await syncHookStore(other);
    await syncHookStore(repo);
    write(userFile(), { hooks: stopHook('notify') });

    const launch = await hooksForLaunch('codex', repo);

    expect(launch.hooks?.Stop?.flatMap((group) => group.hooks)).toEqual([
      { type: 'command', command: 'notify' },
      { type: 'command', command: 'gate' },
    ]);
  });

  it("orders a project's two files as Claude does, whichever Frink stored first", async () => {
    write(path.join(repo, '.claude', 'settings.local.json'), { hooks: stopHook('local') });
    await syncHookStore(repo);
    write(path.join(repo, '.claude', 'settings.json'), { hooks: stopHook('project') });

    const launch = await hooksForLaunch('codex', repo);

    expect(launch.hooks?.Stop?.flatMap((group) => group.hooks)).toEqual([
      { type: 'command', command: 'project' },
      { type: 'command', command: 'local' },
    ]);
  });

  it("honours the user's own off switch, and only when it is on", async () => {
    write(userFile(), { hooks: stopHook('notify'), disableAllHooks: true });
    expect(await hooksForLaunch('claude-code', null)).toEqual({ disableAllHooks: true });

    write(userFile(), { hooks: stopHook('notify'), disableAllHooks: false });
    expect(await hooksForLaunch('claude-code', null)).toEqual({ hooks: stopHook('notify') });
  });

  it('lets the last file that sets the off switch decide it, as Claude merges settings', async () => {
    const committed = path.join(repo, '.claude', 'settings.json');
    const local = path.join(repo, '.claude', 'settings.local.json');
    write(userFile(), { hooks: stopHook('notify'), disableAllHooks: true });
    write(committed, { hooks: stopHook('committed'), disableAllHooks: false });
    write(local, { hooks: stopHook('local') });

    const enabled = await hooksForLaunch('codex', repo);
    expect(enabled.hooks?.Stop).toHaveLength(3);

    write(local, { hooks: stopHook('local'), disableAllHooks: true });
    expect(await hooksForLaunch('claude-code', repo)).toEqual({ disableAllHooks: true });
  });

  it.each([
    ['user', () => userFile()],
    ['project', () => path.join(repo, '.claude', 'settings.json')],
  ])("launches both providers when the %s file's hook list holds a null", async (_scope, file) => {
    const hooks = { Stop: [{ hooks: [null, { type: 'command', command: 'notify' }] }] };
    write(file(), { hooks });

    expect(await hooksForLaunch('codex', repo)).toEqual({ hooks });
    expect(await hooksForLaunch('claude-code', repo)).toEqual({ hooks });
  });

  it("skips a malformed entry under a non-guard event, as Claude does, keeping the file's guard", async () => {
    const guard = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'g' }] }] };
    write(path.join(repo, '.claude', 'settings.json'), {
      hooks: {
        Stop: [{ type: 'command', command: 'afplay done.aiff' }],
        SubagentStop: { hooks: [] },
        Notification: [{ matcher: 1, hooks: [] }, ...stopHook('ping').Stop],
        ...guard,
      },
    });

    const kept = { Notification: stopHook('ping').Stop, ...guard };
    expect(await hooksForLaunch('claude-code', repo)).toEqual({ hooks: kept });
    expect(await hooksForLaunch('codex', repo)).toEqual({ hooks: kept });
  });

  it('holds back a file whose guard group has no hook list, as Claude refuses the file', async () => {
    write(path.join(repo, '.claude', 'settings.json'), {
      hooks: { ...stopHook('committed'), PreToolUse: [{ matcher: 'Bash' }] },
    });

    expect(await hooksForLaunch('claude-code', repo)).toEqual({});
  });

  it('keeps the store current for a provider with no hook delivery yet', async () => {
    write(userFile(), { hooks: stopHook('notify') });

    expect(await hooksForLaunch('gemini', null)).toEqual({});
    expect(fs.existsSync(storeFile())).toBe(true);
  });
});

describe('what a Claude launch is handed: the hooks plugin and its lock, or its own files', () => {
  let home: string;
  let repo: string;
  let claude: string;
  const chat = 'chat-1';
  const userFile = () => path.join(home, '.claude', 'settings.json');
  const write = (file: string, settings: SettingsFile) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings));
  };
  /** The hooks of each plugin a launch is handed. */
  const pluginHooks = (launch: Awaited<ReturnType<typeof claudeHooksForLaunch>>) =>
    (launch.sdkOptions.plugins ?? []).map(
      (plugin) =>
        JSON.parse(fs.readFileSync(path.join(plugin.path, 'hooks', 'hooks.json'), 'utf8')).hooks,
    );
  const launch = () => claudeHooksForLaunch(repo, chat, claude);
  const fallback = { settings: { hooks: stopHook('notify') }, sdkOptions: {} };

  beforeEach(() => {
    const tmp = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'frink-hook-launch-')),
    );
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    vi.stubEnv('FRINK_HOME', home);
    // A stand-in for `claude plugin validate`: it refuses a plugin holding the word REFUSE.
    claude = path.join(tmp, 'claude');
    fs.writeFileSync(
      claude,
      `#!/bin/sh\ngrep -q REFUSE "$4/hooks/hooks.json" && { echo '{"success":false}'; exit 1; }\necho '{"success":true}'\n`,
      { mode: 0o755 },
    );
    write(userFile(), { hooks: stopHook('notify') });
    write(path.join(repo, '.claude', 'settings.json'), { hooks: stopHook('committed') });
  });
  afterEach(() => {
    _resetHooksLockForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  });

  it("hands Claude every hook file as one plugin in Claude's order, under the lock", async () => {
    vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(true);
    write(path.join(repo, '.claude', 'settings.local.json'), { hooks: stopHook('local') });

    const handed = await launch();

    expect(handed.settings).toEqual({});
    expect(handed.sdkOptions.managedSettings).toEqual({ strictPluginOnlyCustomization: ['hooks'] });
    expect(handed.sdkOptions.plugins).toEqual([
      {
        type: 'local',
        path: expect.stringContaining(path.join(home, '.frink', 'hooks', 'plugins')),
      },
    ]);
    const stops = ['notify', 'committed', 'local'].flatMap((command) => stopHook(command).Stop);
    expect(pluginHooks(handed)).toEqual([{ Stop: stops }]);
  });

  it('leaves Claude to its own files, with no notice, when Claude refuses the plugin', async () => {
    vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(true);
    write(path.join(repo, '.claude', 'settings.json'), { hooks: stopHook('REFUSE') });

    expect(await launch()).toEqual(fallback);
    expect(takeHooksLockNotice(chat)).toBeNull();
  });

  it.each([
    ['the user', () => userFile()],
    ["the project's local file", () => path.join(repo, '.claude', 'settings.local.json')],
  ])(
    "locks Claude with no plugin and passes on the off switch when %s turns it on, so a plugin's hooks stop too",
    async (_who, file) => {
      vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(true);
      write(file(), { hooks: stopHook('notify'), disableAllHooks: true });

      expect(await launch()).toEqual({
        settings: { disableAllHooks: true },
        sdkOptions: { managedSettings: { strictPluginOnlyCustomization: ['hooks'] } },
      });
    },
  );

  it('locks Claude with no plugin when no file holds a hook', async () => {
    vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(true);
    fs.rmSync(userFile());
    fs.rmSync(path.join(repo, '.claude', 'settings.json'));

    expect(await launch()).toEqual({
      settings: {},
      sdkOptions: { managedSettings: { strictPluginOnlyCustomization: ['hooks'] } },
    });
  });

  it("leaves Claude to its own files, with the user's hooks, when a policy drops the lock, and tells the chat once", async () => {
    vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(false);

    expect(takeHooksLockNotice(chat)).toBeNull();
    expect(await launch()).toEqual(fallback);
    await launch();
    expect(takeHooksLockNotice(chat)).toMatch(/Claude's own settings files/);
    await launch();
    expect(takeHooksLockNotice(chat)).toBeNull();
    expect(takeHooksLockNotice('another-chat')).toBeNull();
  });

  it("falls back the same way when Claude's check or the lock check cannot run", async () => {
    const lock = vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(true);
    claude = path.join(home, 'no-claude');

    expect(await launch()).toEqual(fallback);

    lock.mockRejectedValue(new Error('unreadable policy'));
    expect(await launch()).toEqual(fallback);
    expect(takeHooksLockNotice(chat)).toBeNull();
  });

  it('stops asking for the lock once a started CLI reports a policy dropped it, and tells that chat', async () => {
    vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(true);
    const answer = vi.spyOn(pluginLock, 'cliRunsPluginOnlyHooks');
    const closed = () => Promise.reject(new Error('the CLI exited'));

    await expect(
      checkClaudeHooksLock({ initializationResult: closed, getHooksListing: closed }, chat),
    ).resolves.toBeUndefined();
    const cli = { initializationResult: vi.fn(), getHooksListing: vi.fn() };
    answer.mockResolvedValueOnce(true).mockResolvedValueOnce(null);
    await checkClaudeHooksLock(cli, chat);
    await checkClaudeHooksLock(cli, chat);
    expect((await launch()).sdkOptions.managedSettings).toBeDefined();
    expect(takeHooksLockNotice(chat)).toBeNull();

    answer.mockResolvedValueOnce(false);
    await checkClaudeHooksLock(cli, chat);
    expect(takeHooksLockNotice(chat)).not.toBeNull();
    expect(await claudeHooksForLaunch(repo, 'later-chat', claude)).toEqual(fallback);
    expect(takeHooksLockNotice('later-chat')).not.toBeNull();
  });
});
