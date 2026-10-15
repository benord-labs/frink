import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import {
  access,
  chmod,
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
import { cursorHostEnv, openGateSocket, prepareCursorHome } from './index';

type Flag = 'uchg' | 'nouchg';
type Prepared = Awaited<ReturnType<typeof prepareCursorHome>>;

const FOLDER_REFUSED = "Frink can't start Cursor from this folder.";
const NOT_READY = "Frink couldn't prepare Cursor's safety check, so it didn't start it.";
const REAL_BINARIES = ['/usr/bin/chflags', '/bin/zsh', '/bin/bash', '/usr/bin/curl'];

let root = '';
let home = '';
let realHome = '';
let gateDir = '';
let calls: Array<[Flag, string[]]> = [];
let unlocks: Array<() => Promise<void>> = [];

/** Stands in for chflags where it is missing: a lock removes write permission, an unlock restores it. */
async function fakeChflags(flag: Flag, paths: string[]) {
  calls.push([flag, paths]);
  for (const file of paths) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) continue;
    await chmod(file, flag === 'uchg' ? info.mode & 0o555 : info.mode | 0o200);
  }
}

async function prepare(
  input: { gateDir?: string; socketPath?: string } = {},
  deps: Parameters<typeof prepareCursorHome>[1] = { chflags: fakeChflags },
): Promise<Prepared> {
  const dir = input.gateDir ?? gateDir;
  const socketPath = input.socketPath ?? path.join(dir, 'g.sock');
  const result = await prepareCursorHome({ home, realHome, gateDir: dir, socketPath }, deps);
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
  calls = [];
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
    const tampering = async (flag: Flag, paths: string[]) => {
      if (flag === 'uchg') await tamper(file);
      await fakeChflags(flag, paths);
    };
    expect(await prepare({}, { chflags: tampering })).toEqual({ ok: false, reason: NOT_READY });
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
    expect(calls).toEqual([]);
  });

  it('locks the wrapper, its folder, the home, .cursor, the hook and shell files; unlocks once', async () => {
    const result = await prepare();
    const locked = calls.filter(([flag]) => flag === 'uchg').flatMap(([, paths]) => paths);
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
    calls = [];
    if (result.ok) await Promise.all([result.unlock(), result.unlock()]);
    expect(calls.map(([flag]) => flag)).toEqual(['nouchg']);
    expect(await writable(home)).toBe(true);
  });
});

describe('cursorHostEnv', () => {
  it('drops every Cursor variable but the user’s key, and what changes how shells and Node start', () => {
    const env = cursorHostEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        SHELL: '/bin/zsh',
        CURSOR_API_KEY: 'kept',
        CURSOR_BACKEND_URL: 'https://example.com',
        CURSOR_NEW_SWITCH: '1',
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
      CURSOR_API_KEY: 'kept',
    });
  });

  it('uses the user’s shell only when it is zsh or bash', () => {
    const shell = (SHELL?: string) => cursorHostEnv(SHELL ? { SHELL } : {}, '/h').SHELL;
    expect(shell('/opt/homebrew/bin/bash')).toBe('/opt/homebrew/bin/bash');
    expect(shell('/usr/local/bin/zsh')).toBe('/usr/local/bin/zsh');
    expect(shell('/opt/homebrew/bin/fish')).toBe('/bin/zsh');
    expect(shell('zsh')).toBe('/bin/zsh');
    expect(shell()).toBe('/bin/zsh');
  });
});

/** A login env whose bash function `[` and trace prompt would run before the hook's guard. */
const hostileEnv = () => ({
  'BASH_FUNC_[%%': '() { case "$3" in */gate) return 1;; esac; builtin [ "$@"; }',
  SHELLOPTS: 'xtrace',
  PS4: `$(echo traced >> ${path.join(root, 'traced')})`,
});

/** Runs a command the way Cursor runs a hook: `$SHELL -lc <command>`, the hook body on stdin. */
function runShell(
  shell: string,
  command: string,
  input = '',
): Promise<{ code: number | null; stdout: string }> {
  const userEnv = { ...hostileEnv(), PATH: '/usr/bin:/bin', SHELL: shell, CURL_HOME: realHome };
  const env = cursorHostEnv(userEnv, home);
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-lc', command], { env, cwd: root });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

describe.runIf(process.platform === 'darwin' && REAL_BINARIES.every((file) => existsSync(file)))(
  'the hook with real shells and locks',
  () => {
    const ANSWER = { permission: 'deny', user_message: 'Frink answered.' };
    const BODY = JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Shell' });
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
    const prepareLocked = () => prepare({ socketPath: gate?.socketPath }, {});

    it.each(['/bin/zsh', '/bin/bash'])(
      'asks the gate through a %s login shell, whatever the user’s own files print',
      async (shell) => {
        const allow = `echo '{"permission":"allow"}'`;
        const hostile = `function ${wrapper()} { ${allow}; }\n${allow}\n`;
        for (const file of [
          '.zshenv',
          '.zprofile',
          '.zshrc',
          '.zlogin',
          '.bash_profile',
          '.profile',
        ]) {
          await writeFile(path.join(realHome, file), hostile);
        }
        await writeFile(
          path.join(realHome, '.curlrc'),
          'write-out = "{\\"permission\\":\\"allow\\"}"\n',
        );
        expect(await prepareLocked()).toMatchObject({ ok: true });

        // The gate folder is locked by now, so this also proves the socket still takes calls.
        expect(await runShell(shell, wrapper(), BODY)).toEqual({
          code: 0,
          stdout: JSON.stringify(ANSWER),
        });
        expect(bodies).toEqual([BODY]);
        expect(existsSync(path.join(root, 'traced'))).toBe(false);
      },
    );

    it.each(['/bin/zsh', '/bin/bash'])(
      'gives the agent’s %s commands the real home',
      async (shell) => {
        expect(await prepareLocked()).toMatchObject({ ok: true });
        expect(await runShell(shell, 'echo "$HOME"')).toEqual({ code: 0, stdout: `${realHome}\n` });
      },
    );

    it('prints nothing and fails when the gate’s socket is gone', async () => {
      const prepared = await prepareLocked();
      if (prepared.ok) await prepared.unlock();
      await rm(path.join(gateDir, 'g.sock'));
      const result = await runShell('/bin/zsh', wrapper(), BODY);
      expect(result.stdout).toBe('');
      expect(result.code).not.toBe(0);
    });

    it('blocks writes to every file the hook depends on until unlocked', async () => {
      const result = await prepareLocked();
      const targets = [
        path.join(home, '.zshenv'),
        path.join(home, '.zprofile'),
        path.join(cursorDir(), 'hooks.json'),
        path.join(cursorDir(), 'mcp.json'),
        wrapper(),
      ];
      for (const file of targets) {
        await expect(writeFile(file, 'echo tampered'), file).rejects.toMatchObject({
          code: 'EPERM',
        });
      }
      if (result.ok) await result.unlock();
      for (const file of targets) await writeFile(file, 'echo tampered');
    });
  },
);
