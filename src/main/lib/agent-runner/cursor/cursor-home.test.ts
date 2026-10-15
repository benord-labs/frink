import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HomeLock, modeLock, userDirsOf } from './cursor-home';
import { recordingLock } from './cursor-test-fixtures';
import { cursorHostEnv, openGateSocket, prepareCursorHome } from './index';

type Env = Record<string, string>;
type Prepared = Awaited<ReturnType<typeof prepareCursorHome>>;

const FOLDER_REFUSED = "Frink can't start Cursor from this folder.";
const NOT_READY = "Frink couldn't prepare Cursor's safety check, so it didn't start it.";
const NEEDS_CURL =
  "Cursor in Frink needs curl. Install curl with your system's software installer, then try again.";
const DARWIN = process.platform === 'darwin';
const REAL_BINARIES = ['/bin/bash', '/usr/bin/curl', ...(DARWIN ? ['/usr/bin/chflags'] : [])];
const SHELLS = ['/bin/zsh', '/bin/bash'].filter((shell) => existsSync(shell));
/** Each lock run for real here: the platform's own, and on macOS Linux's write-bit lock too. */
const REAL_LOCKS: Array<[name: string, lock: HomeLock | undefined, refused: string]> = DARWIN
  ? [
      ['chflags', undefined, 'EPERM'],
      ['write-bit', modeLock, 'EACCES'],
    ]
  : [['write-bit', undefined, 'EACCES']];

let root = '';
let home = '';
let realHome = '';
let gateDir = '';
let recorder = recordingLock();
let unlocks: Array<() => Promise<void>> = [];

async function prepare(
  input: { gateDir?: string; socketPath?: string; userDirs?: Env } = {},
  deps: Parameters<typeof prepareCursorHome>[1] = { lock: recorder.lock },
): Promise<Prepared> {
  const dir = input.gateDir ?? gateDir;
  const socketPath = input.socketPath ?? path.join(dir, 'g.sock');
  const userDirs = input.userDirs ?? {};
  const result = await prepareCursorHome(
    { home, realHome, userDirs, gateDir: dir, socketPath },
    deps,
  );
  if (result.ok) unlocks.push(result.unlock);
  return result;
}

const cursorDir = () => path.join(home, '.cursor');
const sorted = async (dir: string) => (await readdir(dir)).sort();
const writable = (file: string) =>
  access(file, constants.W_OK).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cursor-home-'));
  // A space in the path, as in macOS's Application Support folder.
  home = path.join(root, 'app data', 'cursor', 'chats', 'c1', 'home');
  realHome = path.join(root, 'real');
  gateDir = path.join(root, 'gate');
  for (const dir of [realHome, gateDir]) await mkdir(dir);
  recorder = recordingLock();
  unlocks = [];
});
afterEach(async () => {
  for (const unlock of unlocks) await unlock();
  await rm(root, { recursive: true, force: true });
});

describe('prepareCursorHome', () => {
  it('keeps only Frink’s files in the private home and its .cursor folder', async () => {
    await mkdir(path.join(home, '.cursor', 'rules'), { recursive: true });
    await mkdir(path.join(home, '.cursor', 'sdk'), { recursive: true });
    await mkdir(path.join(home, '.cursor', 'projects', 'p'), { recursive: true });
    await mkdir(path.join(home, 'junk'));
    for (const file of ['.zshrc', '.curlrc', '.cursor/mcp.json', '.cursor/cli.json']) {
      await writeFile(path.join(home, file), 'x');
    }
    await writeFile(path.join(home, '.cursor', 'sdk', 'asset.bin'), 'kept');
    await writeFile(path.join(home, '.cursor', 'projects', 'p', 'state'), 'kept');

    expect(await prepare()).toMatchObject({ ok: true });
    expect((await lstat(home)).mode & 0o077).toBe(0);
    expect(await sorted(home)).toEqual(['.bash_profile', '.cursor', '.profile', '.zshenv']);
    expect(await sorted(cursorDir())).toEqual(['hooks.json', 'projects', 'sdk']);
    expect(await sorted(path.join(cursorDir(), 'sdk'))).toEqual(['asset.bin', 'auth.json']);
    expect(await readFile(path.join(cursorDir(), 'projects', 'p', 'state'), 'utf8')).toBe('kept');
  });

  it.each(['.cursor', '.cursor/sdk', '.cursor/projects'])(
    'rebuilds %s as a folder when a file or link sits in its place',
    async (name) => {
      const target = path.join(home, name);
      await writeFile(path.join(realHome, 'notes.txt'), 'mine');
      await mkdir(path.dirname(target), { recursive: true });
      for (const plant of [() => writeFile(target, 'x'), () => symlink(realHome, target)]) {
        for (const unlock of unlocks.splice(0)) await unlock();
        await rm(target, { recursive: true, force: true });
        await plant();
        expect(await prepare()).toMatchObject({ ok: true });
        expect((await lstat(target)).isDirectory()).toBe(true);
      }
      expect(await sorted(realHome)).toEqual(['notes.txt']);
    },
  );

  it('refuses a private home that is a link, leaving what it points at untouched', async () => {
    await writeFile(path.join(realHome, 'notes.txt'), 'mine');
    await mkdir(path.dirname(home), { recursive: true });
    await symlink(realHome, home);
    expect(await prepare()).toEqual({ ok: false, reason: NOT_READY });
    expect(await sorted(realHome)).toEqual(['notes.txt']);
  });

  it('writes the hook file Cursor reads, sending every check to the gate', async () => {
    await prepare();
    const check = [{ command: path.join(gateDir, 'gate'), failClosed: true, timeout: 86400 }];
    expect(JSON.parse(await readFile(path.join(cursorDir(), 'hooks.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: {
        preToolUse: check,
        beforeShellExecution: check,
        beforeMCPExecution: check,
        beforeSubmitPrompt: check,
      },
    });
  });

  it('rewrites an emptied or edited hook file on the next turn', async () => {
    const hooksFile = path.join(cursorDir(), 'hooks.json');
    await prepare();
    const written = await readFile(hooksFile, 'utf8');
    for (const tampered of ['', '{"version":1,"hooks":{}}']) {
      for (const unlock of unlocks.splice(0)) await unlock();
      await writeFile(hooksFile, tampered);
      expect(await prepare()).toMatchObject({ ok: true });
      expect(await readFile(hooksFile, 'utf8')).toBe(written);
    }
  });

  const allow = `echo '{"permission":"allow"}'\n`;
  it.each([
    [
      'the wrapper is swapped for a link',
      'gate',
      (file: string) => rm(file).then(() => symlink('/bin/echo', file)),
    ],
    ['the wrapper is rewritten', 'gate', (file: string) => writeFile(file, allow)],
    ['a shell file is rewritten', '.zshenv', (file: string) => writeFile(file, allow)],
  ])('refuses the turn, unlocked, when %s before the lock', async (_, name, tamper) => {
    const file = path.join(name === 'gate' ? gateDir : home, name);
    const tampering: HomeLock = async (on, paths) => {
      if (on) await tamper(file);
      await recorder.lock(on, paths);
    };
    expect(await prepare({}, { lock: tampering })).toEqual({ ok: false, reason: NOT_READY });
    expect(await writable(home)).toBe(true);
    expect(await writable(path.join(cursorDir(), 'hooks.json'))).toBe(true);
  });

  it('replaces a stored sign-in file with a link to the user’s own sign-in', async () => {
    const auth = path.join(cursorDir(), 'sdk', 'auth.json');
    await mkdir(path.dirname(auth), { recursive: true });
    await writeFile(auth, '{"stale":true}');

    expect(await prepare()).toMatchObject({ ok: true });
    expect((await lstat(auth)).isSymbolicLink()).toBe(true);
    expect(await readlink(auth)).toBe(path.join(realHome, '.cursor', 'sdk', 'auth.json'));
  });

  it('links the sign-in without opening it', async () => {
    const realAuth = path.join(realHome, '.cursor', 'sdk', 'auth.json');
    await mkdir(path.dirname(realAuth), { recursive: true });
    await writeFile(realAuth, '{}', { mode: 0o000 });
    expect(await prepare()).toMatchObject({ ok: true });
  });

  it('refuses a gate folder Cursor cannot run from', async () => {
    const spaced = path.join(root, 'gate folder');
    expect(await prepare({ gateDir: spaced })).toEqual({ ok: false, reason: FOLDER_REFUSED });
    const long = path.join(gateDir, 'x'.repeat(100), 'g.sock');
    expect(await prepare({ socketPath: long })).toEqual({ ok: false, reason: FOLDER_REFUSED });
    expect(recorder.calls).toEqual([]);
  });

  it('runs the first curl found in the system folders, never one from PATH', async () => {
    const [none, notRunnable, found] = ['none', 'not runnable', 'found'].map((name) =>
      path.join(root, name),
    );
    await mkdir(notRunnable);
    await mkdir(found);
    await writeFile(path.join(notRunnable, 'curl'), '', { mode: 0o600 });
    await writeFile(path.join(found, 'curl'), '', { mode: 0o700 });
    const curlDirs = [none, notRunnable, found];
    expect(await prepare({}, { lock: recorder.lock, curlDirs })).toMatchObject({ ok: true });
    const wrapper = await readFile(path.join(gateDir, 'gate'), 'utf8');
    expect(wrapper).toContain(`\nexec ${path.join(found, 'curl')} -q -s --fail --unix-socket `);
  });

  it('asks for curl, and starts nothing, when no system folder has it', async () => {
    const curlDirs = [path.join(root, 'none')];
    expect(await prepare({}, { lock: recorder.lock, curlDirs })).toEqual({
      ok: false,
      reason: NEEDS_CURL,
    });
    expect(recorder.calls).toEqual([]);
  });

  it('locks the wrapper, its folder, the home, .cursor, the hook and shell files; unlocks once', async () => {
    const result = await prepare();
    const locked = recorder.calls.filter(([on]) => on).flatMap(([, paths]) => paths);
    expect([...locked].sort()).toEqual(
      [
        gateDir,
        path.join(gateDir, 'gate'),
        home,
        cursorDir(),
        path.join(cursorDir(), 'hooks.json'),
        path.join(home, '.zshenv'),
        path.join(home, '.bash_profile'),
        path.join(home, '.profile'),
      ].sort(),
    );
    recorder.calls.length = 0;
    if (result.ok) await Promise.all([result.unlock(), result.unlock()]);
    expect(recorder.calls.map(([on]) => on)).toEqual([false]);
    expect(await writable(home)).toBe(true);
  });

  it.each(['gate', '.cursor', 'hooks.json', '.zshenv', '.bash_profile'])(
    'refuses the turn, unlocked, when the lock leaves %s writable',
    async (name) => {
      const skipped = (file: string) => path.basename(file) === name;
      const leaky: HomeLock = (on, paths) =>
        recorder.lock(on, on ? paths.filter((file) => !skipped(file)) : paths);
      expect(await prepare({}, { lock: leaky })).toEqual({ ok: false, reason: NOT_READY });
      expect(await writable(home)).toBe(true);
    },
  );
});

describe('modeLock', () => {
  it('locks a file and a folder for their owner and unlocks them, never through a link', async () => {
    const file = path.join(root, 'file');
    const link = path.join(root, 'link');
    await writeFile(file, 'x', { mode: 0o600 });
    await symlink(file, link);

    await modeLock(true, [link, gateDir]);
    expect(await writable(file)).toBe(true);
    expect(await writable(gateDir)).toBe(false);
    await expect(writeFile(path.join(gateDir, 'new'), 'x')).rejects.toMatchObject({
      code: 'EACCES',
    });

    await modeLock(true, [file]);
    expect((await lstat(file)).mode & 0o777).toBe(0o400);
    await modeLock(false, [file, gateDir]);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(await writable(gateDir)).toBe(true);
  });

  it('still unlocks every other path when one of them fails', async () => {
    await modeLock(true, [gateDir]);
    await expect(modeLock(false, [path.join(root, 'missing'), gateDir])).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await writable(gateDir)).toBe(true);
  });
});

describe('cursorHostEnv', () => {
  it('drops every Cursor variable, the user’s key too, and what changes how shells and Node start', () => {
    const env = cursorHostEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        SHELL: '/bin/zsh',
        CURSOR_API_KEY: 'dropped',
        CURSOR_BACKEND_URL: 'https://example.com',
        CURSOR_NEW_SWITCH: '1',
        __CURSOR_SANDBOX_ENV_RESTORE: 'touch /tmp/x',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require x',
        ZDOTDIR: '/tmp/z',
        BASH_ENV: '/tmp/b',
        ENV: '/tmp/e',
        'BASH_FUNC_[%%': '() { :\n}',
        SHELLOPTS: 'xtrace',
        BASHOPTS: 'extglob',
      },
      '/private/home',
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/private/home',
      SHELL: '/bin/zsh',
    });
  });

  it.each<[NodeJS.Platform, string]>([
    ['darwin', '/bin/zsh'],
    ['linux', '/bin/bash'],
  ])('on %s, uses the user’s shell only when it is zsh or bash, else %s', (platform, stock) => {
    const shell = (SHELL?: string) => cursorHostEnv(SHELL ? { SHELL } : {}, '/h', platform).SHELL;
    expect(shell('/opt/homebrew/bin/bash')).toBe('/opt/homebrew/bin/bash');
    expect(shell('/usr/local/bin/zsh')).toBe('/usr/local/bin/zsh');
    expect(shell('/opt/homebrew/bin/fish')).toBe(stock);
    expect(shell('zsh')).toBe(stock);
    expect(shell()).toBe(stock);
  });

  it('on Linux, holds back the XDG folders a system zshenv can point ZDOTDIR into', () => {
    const userEnv = {
      PATH: '/usr/bin',
      XDG_CONFIG_HOME: '/home/me/.config',
      XDG_DATA_HOME: '/home/me/.local/share',
      XDG_STATE_HOME: '',
      XDG_CACHE_HOME: '/home/me/.cache',
      XDG_RUNTIME_DIR: '/run/user/1000',
    };
    const held = {
      XDG_CONFIG_HOME: '/home/me/.config',
      XDG_DATA_HOME: '/home/me/.local/share',
      XDG_STATE_HOME: '',
      XDG_CACHE_HOME: '/home/me/.cache',
    };
    expect(cursorHostEnv(userEnv, '/h', 'linux')).toEqual({
      PATH: '/usr/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
      HOME: '/h',
      SHELL: '/bin/bash',
    });
    expect(userDirsOf(userEnv, 'linux')).toEqual(held);
    expect(cursorHostEnv(userEnv, '/h', 'darwin')).toMatchObject(held);
    expect(userDirsOf(userEnv, 'darwin')).toEqual({});
  });
});

/** A login env whose bash function `[` and trace prompt would run before the hook's guard. */
const hostileEnv = () => ({
  'BASH_FUNC_[%%': '() { case "$3" in */gate) return 1;; esac; builtin [ "$@"; }',
  SHELLOPTS: 'xtrace',
  PS4: `$(echo traced >> ${path.join(root, 'traced')})`,
});

type ShellRun = { input?: string; userDirs?: Env; platform?: NodeJS.Platform; flags?: string };

/** Runs a command the way Cursor runs a hook: `$SHELL -lc <command>`, the hook body on stdin. */
function runShell(
  shell: string,
  command: string,
  { input = '', userDirs = {}, platform = process.platform, flags = '-lc' }: ShellRun = {},
): Promise<{ code: number | null; stdout: string }> {
  const userEnv = {
    ...hostileEnv(),
    ...userDirs,
    PATH: '/usr/bin:/bin',
    SHELL: shell,
    CURL_HOME: realHome,
  };
  const env = cursorHostEnv(userEnv, home, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [flags, command], { env, cwd: root });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

describe.runIf(REAL_BINARIES.every((file) => existsSync(file))).each(REAL_LOCKS)(
  'the hook with real shells and the %s lock',
  (_, lock, refused) => {
    const ANSWER = { permission: 'deny', user_message: 'Frink answered.' };
    const BODY = JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Shell' });
    const allow = `echo '{"permission":"allow"}'`;
    let gate: Awaited<ReturnType<typeof openGateSocket>> | undefined;
    let bodies: string[] = [];

    beforeEach(async () => {
      bodies = [];
      gate = await openGateSocket(async (body) => {
        bodies.push(body);
        return ANSWER;
      });
      gateDir = gate.gateDir;
    });
    afterEach(async () => {
      for (const unlock of unlocks.splice(0)) await unlock();
      await gate?.close();
    });

    const wrapper = () => path.join(gateDir, 'gate');
    const hostile = () => `function ${wrapper()} { ${allow}; }\n${allow}\n`;
    const prepareLocked = (userDirs: Env = {}) =>
      prepare({ socketPath: gate?.socketPath, userDirs }, { lock });

    it.each(SHELLS)(
      'asks the gate through a %s login shell, whatever the user’s own files print',
      async (shell) => {
        for (const file of [
          '.zshenv',
          '.zprofile',
          '.zshrc',
          '.zlogin',
          '.bash_profile',
          '.profile',
        ]) {
          await writeFile(path.join(realHome, file), hostile());
        }
        await writeFile(
          path.join(realHome, '.curlrc'),
          'write-out = "{\\"permission\\":\\"allow\\"}"\n',
        );
        expect(await prepareLocked()).toMatchObject({ ok: true });

        // The gate folder is locked by now, so this also proves the socket still takes calls.
        expect(await runShell(shell, wrapper(), { input: BODY })).toEqual({
          code: 0,
          stdout: JSON.stringify(ANSWER),
        });
        expect(bodies).toEqual([BODY]);
        expect(existsSync(path.join(root, 'traced'))).toBe(false);
      },
    );

    it.runIf(existsSync('/bin/zsh'))(
      'on Linux, keeps the hook’s zsh out of the user’s files when a system zshenv moves ZDOTDIR',
      async () => {
        const config = path.join(realHome, 'my config');
        await mkdir(path.join(config, 'zsh'), { recursive: true });
        await writeFile(path.join(config, 'zsh', '.zshenv'), hostile());
        expect(await prepareLocked({ XDG_CONFIG_HOME: config })).toMatchObject({ ok: true });

        // The line some Linux systems ship in /etc/zsh/zshenv, run before any of the user's files.
        const systemZshenv = `export ZDOTDIR="\${XDG_CONFIG_HOME:-$HOME/.config}/zsh"; exec /bin/zsh -lc ${wrapper()}`;
        const run: ShellRun = {
          input: BODY,
          userDirs: { XDG_CONFIG_HOME: config },
          platform: 'linux',
        };
        expect(await runShell('/bin/zsh', systemZshenv, { ...run, flags: '-fc' })).toEqual({
          code: 0,
          stdout: JSON.stringify(ANSWER),
        });
        expect(await runShell('/bin/bash', 'echo "$XDG_CONFIG_HOME"', run)).toEqual({
          code: 0,
          stdout: `${config}\n`,
        });
      },
    );

    it.each(SHELLS)('gives the agent’s %s commands the real home', async (shell) => {
      expect(await prepareLocked()).toMatchObject({ ok: true });
      expect(await runShell(shell, 'echo "$HOME"')).toEqual({ code: 0, stdout: `${realHome}\n` });
    });

    it.each(['.bash_login', '.profile'])(
      'gives the agent’s bash commands the user’s %s when there is no .bash_profile',
      async (file) => {
        await writeFile(path.join(realHome, file), 'export MARK=from-the-user\n');
        expect(await prepareLocked()).toMatchObject({ ok: true });
        expect(await runShell('/bin/bash', 'echo "$MARK"')).toEqual({
          code: 0,
          stdout: 'from-the-user\n',
        });
      },
    );

    it('prints nothing and fails when the gate’s socket is gone', async () => {
      const prepared = await prepareLocked();
      if (prepared.ok) await prepared.unlock();
      await rm(path.join(gateDir, 'g.sock'));
      const result = await runShell('/bin/bash', wrapper(), { input: BODY });
      expect(result.stdout).toBe('');
      expect(result.code).not.toBe(0);
    });

    it('blocks writes to every file the hook depends on, and removing one, until unlocked', async () => {
      const result = await prepareLocked();
      const targets = [
        path.join(home, '.zshenv'),
        path.join(home, '.zprofile'),
        path.join(home, '.zlogin'),
        path.join(home, '.curlrc'),
        path.join(cursorDir(), 'hooks.json'),
        path.join(cursorDir(), 'mcp.json'),
        wrapper(),
      ];
      for (const file of targets) {
        await expect(writeFile(file, 'echo tampered'), file).rejects.toMatchObject({
          code: refused,
        });
      }
      const profile = path.join(home, '.bash_profile');
      await expect(rm(profile)).rejects.toMatchObject({ code: refused });
      if (result.ok) await result.unlock();
      for (const file of targets) await writeFile(file, 'echo tampered');
      await rm(profile);
    });
  },
);
