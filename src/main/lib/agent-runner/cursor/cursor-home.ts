import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import { stockShell } from '../../platform/login-shell-env';
import { shellQuote } from '../acp/acp-command-ledger';

type Env = Record<string, string>;
/** Locks or unlocks the files and folders the hook depends on, never through a link. */
export type HomeLock = (on: boolean, paths: string[]) => Promise<void>;
type Written = [file: string, text: string, mode: number];

/** Cursor runs the hook as an unquoted shell command, so its path must need no quoting. */
const PLAIN_PATH = /^[A-Za-z0-9._/-]+$/;
/** macOS caps a socket path at 104 bytes, the closing NUL included. */
const MAX_SOCKET_PATH_BYTES = 103;
/** Folders the sweep keeps; every file is rewritten each turn. */
const HOME_KEEP = new Set(['.cursor']);
const CURSOR_KEEP = new Set(['sdk', 'projects']);
const HOOK_EVENTS = [
  'preToolUse',
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeSubmitPrompt',
];
/** Variables that change how Node, Electron or the shells start; bash also imports functions. */
const DROPPED_VARS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'ZDOTDIR',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
]);
/** On Linux a system zshenv can set ZDOTDIR from these, so the hook's shell would skip the private guard. */
const XDG_HOMES = new Set(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']);
// CURSOR_API_KEY goes too: Frink uses only Cursor's own sign-in, which Sign in can replace.
const DROPPED_PREFIX = /^(_*CURSOR_|BASH_FUNC_)/;
const FOLDER_REFUSED = "Frink can't start Cursor from this folder.";
const NOT_READY = "Frink couldn't prepare Cursor's safety check, so it didn't start it.";

const chflagsLock: HomeLock = async (on, paths) => {
  await promisify(execFile)('/usr/bin/chflags', ['-h', on ? 'uchg' : 'nouchg', ...paths]);
};

async function setWriteBit(on: boolean, file: string) {
  // A link holds no lock; the read-back refuses one where a file belongs.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(file, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ELOOP') throw error;
  });
  if (!handle) return;
  try {
    const { mode } = await handle.stat();
    await handle.chmod(on ? mode & 0o555 : mode | 0o200);
  } finally {
    await handle.close();
  }
}

/** Linux has no immutable flag a user may set, so the lock takes away the owner's write bit. */
export const modeLock: HomeLock = async (on, paths) => {
  const failed = (await Promise.allSettled(paths.map((file) => setWriteBit(on, file)))).find(
    (result) => result.status === 'rejected',
  );
  if (failed) throw failed.reason;
};

/** The XDG folders the host env leaves out on Linux, which the agent's commands get back. */
export function userDirsOf(userEnv: Env, platform = process.platform): Env {
  if (platform !== 'linux') return {};
  return Object.fromEntries(Object.entries(userEnv).filter(([key]) => XDG_HOMES.has(key)));
}

/** The user's login-shell env for Cursor's process, with HOME set to the chat's private folder. */
export function cursorHostEnv(userEnv: Env, home: string, platform = process.platform) {
  const held = userDirsOf(userEnv, platform);
  const kept = Object.entries(userEnv).filter(
    ([key]) => !DROPPED_PREFIX.test(key) && !DROPPED_VARS.has(key) && !Object.hasOwn(held, key),
  );
  const shell = userEnv.SHELL ?? '';
  const usable = path.isAbsolute(shell) && ['zsh', 'bash'].includes(path.basename(shell));
  return { ...Object.fromEntries(kept), HOME: home, SHELL: usable ? shell : stockShell(platform) };
}

function hooksJson(gate: string): string {
  const check = [{ command: gate, failClosed: true, timeout: 86400 }];
  return JSON.stringify(
    { version: 1, hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, check])) },
    null,
    2,
  );
}

/** The hook's own shell stops at the guard; the agent's commands get the user's real home and files. */
function shellFiles(realHome: string, userDirs: Env, gate: string) {
  const home = shellQuote(realHome);
  const restored = [`HOME=${home}`]
    .concat(Object.entries(userDirs).map(([key, value]) => `${key}=${shellQuote(value)}`))
    .join(' ');
  // Like a bash login shell, it reads the first of the user's files that exists.
  const bash = (names: string) =>
    `[ "$BASH_EXECUTION_STRING" = ${gate} ] && return\nexport ${restored}\nfor f in ${names}; do [ -f "$HOME/$f" ] && { . "$HOME/$f"; break; }; done\n`;
  return {
    '.zshenv': `[[ "$ZSH_EXECUTION_STRING" == ${gate} ]] && return\nexport ${restored} ZDOTDIR=${home}\n[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\n`,
    '.bash_profile': bash('.bash_profile .bash_login .profile'),
    '.profile': bash('.profile'),
  };
}

/** Writes a fresh file, never through a link left in its place. */
async function replaceFile(file: string, text: string, mode: number) {
  await rm(file, { recursive: true, force: true });
  await writeFile(file, text, { mode, flag: 'wx' });
}

async function sweep(dir: string, keep: Set<string>) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (keep.has(entry.name) && entry.isDirectory()) continue;
    await rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function clearLocks(lock: HomeLock, paths: string[]) {
  const found = await Promise.all(
    paths.map((file) =>
      lstat(file).then(
        () => file,
        () => '',
      ),
    ),
  );
  const present = found.filter(Boolean);
  if (present.length > 0) await lock(false, present);
}

async function isWritten([file, text]: Written) {
  const info = await lstat(file);
  return info.isFile() && (await readFile(file, 'utf8')) === text;
}

async function readsBack(written: Written[], gate: string, auth: string, locked: string[]) {
  const [files, wrapper, link] = await Promise.all([
    Promise.all(written.map(isWritten)),
    lstat(gate),
    lstat(auth),
  ]);
  if (files.includes(false) || (wrapper.mode & 0o100) === 0 || !link.isSymbolicLink()) return false;
  const writable = await Promise.all(
    locked.map((file) =>
      access(file, constants.W_OK).then(
        () => true,
        () => false,
      ),
    ),
  );
  return !writable.includes(true);
}

/** Rebuilds the chat's private home with only Frink's hook, then locks what the hook depends on. */
export async function prepareCursorHome(
  input: { home: string; realHome: string; userDirs: Env; gateDir: string; socketPath: string },
  deps: { lock?: HomeLock } = {},
): Promise<{ ok: true; unlock(): Promise<void> } | { ok: false; reason: string }> {
  const { home, realHome, userDirs, gateDir, socketPath } = input;
  if (!PLAIN_PATH.test(gateDir) || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return { ok: false, reason: FOLDER_REFUSED };
  }
  const lock = deps.lock ?? (process.platform === 'darwin' ? chflagsLock : modeLock);
  const cursorDir = path.join(home, '.cursor');
  const gate = path.join(gateDir, 'gate');
  const hooksFile = path.join(cursorDir, 'hooks.json');
  const auth = path.join(cursorDir, 'sdk', 'auth.json');
  // `-q` must come first: curl then reads no .curlrc from any folder.
  const wrapper = `#!/bin/sh\nexec /usr/bin/curl -q -s --fail --unix-socket ${shellQuote(socketPath)} -H 'content-type: application/json' --data-binary @- http://frink/hook\n`;
  const shells = Object.entries(shellFiles(realHome, userDirs, gate)).map(
    ([name, text]): Written => [path.join(home, name), text, 0o600],
  );
  const written: Written[] = [
    [gate, wrapper, 0o700],
    [hooksFile, hooksJson(gate), 0o600],
    ...shells,
  ];
  const homeLocks = [home, cursorDir, hooksFile, ...shells.map(([file]) => file)];
  const locked = [gate, gateDir, ...homeLocks];
  let unlocked: Promise<void> | undefined;
  const unlock = () => (unlocked ??= clearLocks(lock, locked));
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    // Never sweep through a link: it could point at the user's real files.
    if (!(await lstat(home)).isDirectory()) throw new Error('The private home is not a folder');
    await clearLocks(lock, homeLocks);
    await chmod(home, 0o700);
    await sweep(home, HOME_KEEP);
    await mkdir(cursorDir, { recursive: true, mode: 0o700 });
    await sweep(cursorDir, CURSOR_KEEP);
    await mkdir(path.join(cursorDir, 'projects'), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(auth), { recursive: true, mode: 0o700 });
    await rm(auth, { recursive: true, force: true });
    await symlink(path.join(realHome, '.cursor', 'sdk', 'auth.json'), auth);
    for (const [file, text, mode] of written) await replaceFile(file, text, mode);
    await lock(true, locked);
    if (await readsBack(written, gate, auth, locked)) return { ok: true, unlock };
  } catch (error) {
    log.warn("[Cursor] Could not prepare the chat's private home", error);
  }
  await unlock().catch((error) => log.warn('[Cursor] Could not unlock the private home', error));
  return { ok: false, reason: NOT_READY };
}
