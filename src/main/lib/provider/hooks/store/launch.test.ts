import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitAsTestUser as git } from '../../../test-utils/git-as-test-user';
import { hooksForLaunch } from './launch';
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

  it("imports a project's uncommitted hooks but leaves committed ones in the repo", async () => {
    const committed = path.join(repo, '.claude', 'settings.json');
    const local = path.join(repo, '.claude', 'settings.local.json');
    write(committed, { hooks: stopHook('committed') });
    git(repo, 'add', '.claude/settings.json');
    write(local, { hooks: stopHook('gate') });

    const store = await syncHookStore(repo);

    expect(store.sources).toMatchObject({ [local]: { scope: 'project', projectRoot: repo } });
    expect(Object.hasOwn(store.sources, committed)).toBe(false);
  });

  it('drops a project entry once the repo commits that file', async () => {
    const local = path.join(repo, '.claude', 'settings.local.json');
    write(local, { hooks: stopHook('gate') });
    await syncHookStore(repo);

    git(repo, 'add', '-f', '.claude/settings.local.json');

    expect(Object.hasOwn((await syncHookStore(repo)).sources, local)).toBe(false);
  });

  it('reads a project reached through a symlink like the real path', async () => {
    const committed = path.join(repo, '.claude', 'settings.json');
    write(committed, { hooks: stopHook('committed') });
    git(repo, 'add', '.claude/settings.json');
    write(path.join(repo, '.claude', 'settings.local.json'), { hooks: stopHook('gate') });
    const linked = path.join(path.dirname(repo), 'linked');
    fs.symlinkSync(repo, linked);

    expect(await hooksForLaunch('codex', linked)).toEqual({ hooks: stopHook('gate') });
  });

  it('keeps what it stored when git cannot say whether the repo commits a file', async () => {
    const folder = path.join(path.dirname(repo), 'broken');
    const local = path.join(folder, '.claude', 'settings.local.json');
    write(local, { hooks: stopHook('gate') });
    await syncHookStore(folder);

    writeText(path.join(folder, '.git'), 'gitdir: /nowhere');
    write(local, { hooks: stopHook('edited') });

    expect(await hooksForLaunch('codex', folder)).toEqual({ hooks: stopHook('gate') });
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

  it("never hands Claude a project's hooks, which it loads from the project itself", async () => {
    write(userFile(), { hooks: stopHook('notify') });
    write(path.join(repo, '.claude', 'settings.local.json'), { hooks: stopHook('gate') });

    expect(await hooksForLaunch('claude-code', repo)).toEqual({ hooks: stopHook('notify') });
  });

  it("hands Codex the user's hooks, then this project's uncommitted ones, never another's", async () => {
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

  it('keeps the store current for a provider with no hook delivery yet', async () => {
    write(userFile(), { hooks: stopHook('notify') });

    expect(await hooksForLaunch('cursor', null)).toEqual({});
    expect(fs.existsSync(storeFile())).toBe(true);
  });
});
