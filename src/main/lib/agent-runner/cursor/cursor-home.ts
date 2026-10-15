import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import { shellQuote } from '../acp/acp-command-ledger';

type Env = Record<string, string>;
type Chflags = (flag: 'uchg' | 'nouchg', paths: string[]) => Promise<void>;
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
const DROPPED_PREFIX = /^(CURSOR_|BASH_FUNC_)/;
const FOLDER_REFUSED = "Frink can't start Cursor from this folder.";
const NOT_READY = "Frink couldn't prepare Cursor's safety check, so it didn't start it.";

const runChflags: Chflags = async (flag, paths) => {
  await promisify(execFile)('/usr/bin/chflags', ['-h', flag, ...paths]);
};

/** The user's login-shell env for Cursor's process, with HOME set to the chat's private folder. */
export function cursorHostEnv(userEnv: Env, home: string) {
  const kept = Object.entries(userEnv).filter(
    ([key]) => key === 'CURSOR_API_KEY' || (!DROPPED_PREFIX.test(key) && !DROPPED_VARS.has(key)),
  );
  const shell = userEnv.SHELL ?? '';
  const usable = path.isAbsolute(shell) && ['zsh', 'bash'].includes(path.basename(shell));
  return { ...Object.fromEntries(kept), HOME: home, SHELL: usable ? shell : '/bin/zsh' };
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
function shellFiles(realHome: string, gate: string) {
  const home = shellQuote(realHome);
  const bash = (name: string) =>
    `[ "$BASH_EXECUTION_STRING" = ${gate} ] && return\nexport HOME=${home}\n[ -f "$HOME/${name}" ] && . "$HOME/${name}"\n`;
  return {
    '.zshenv': `[[ "$ZSH_EXECUTION_STRING" == ${gate} ]] && return\nexport HOME=${home} ZDOTDIR=${home}\n[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\n`,
    '.bash_profile': bash('.bash_profile'),
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

async function clearLocks(chflags: Chflags, paths: string[]) {
  const found = await Promise.all(
    paths.map((file) =>
      lstat(file).then(
        () => file,
        () => '',
      ),
    ),
  );
  const present = found.filter(Boolean);
  if (present.length > 0) await chflags('nouchg', present);
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
  input: { home: string; realHome: string; gateDir: string; socketPath: string },
  deps: { chflags?: Chflags } = {},
): Promise<{ ok: true; unlock(): Promise<void> } | { ok: false; reason: string }> {
  const { home, realHome, gateDir, socketPath } = input;
  if (!PLAIN_PATH.test(gateDir) || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return { ok: false, reason: FOLDER_REFUSED };
  }
  const chflags = deps.chflags ?? runChflags;
  const cursorDir = path.join(home, '.cursor');
  const gate = path.join(gateDir, 'gate');
  const hooksFile = path.join(cursorDir, 'hooks.json');
  const auth = path.join(cursorDir, 'sdk', 'auth.json');
  // `-q` must come first: curl then reads no .curlrc from any folder.
  const wrapper = `#!/bin/sh\nexec /usr/bin/curl -q -s --fail --unix-socket ${shellQuote(socketPath)} -H 'content-type: application/json' --data-binary @- http://frink/hook\n`;
  const shells = Object.entries(shellFiles(realHome, gate)).map(([name, text]): Written => [
    path.join(home, name),
    text,
    0o600,
  ]);
  const written: Written[] = [
    [gate, wrapper, 0o700],
    [hooksFile, hooksJson(gate), 0o600],
    ...shells,
  ];
  const homeLocks = [home, cursorDir, hooksFile, ...shells.map(([file]) => file)];
  const locked = [gate, gateDir, ...homeLocks];
  let unlocked: Promise<void> | undefined;
  const unlock = () => (unlocked ??= clearLocks(chflags, locked));
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    // Never sweep through a link: it could point at the user's real files.
    if (!(await lstat(home)).isDirectory()) throw new Error('The private home is not a folder');
    await clearLocks(chflags, homeLocks);
    await chmod(home, 0o700);
    await sweep(home, HOME_KEEP);
    await mkdir(cursorDir, { recursive: true, mode: 0o700 });
    await sweep(cursorDir, CURSOR_KEEP);
    await mkdir(path.join(cursorDir, 'projects'), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(auth), { recursive: true, mode: 0o700 });
    await rm(auth, { recursive: true, force: true });
    await symlink(path.join(realHome, '.cursor', 'sdk', 'auth.json'), auth);
    for (const [file, text, mode] of written) await replaceFile(file, text, mode);
    await chflags('uchg', locked);
    if (await readsBack(written, gate, auth, locked)) return { ok: true, unlock };
  } catch (error) {
    log.warn("[Cursor] Could not prepare the chat's private home", error);
  }
  await unlock().catch((error) => log.warn('[Cursor] Could not unlock the private home', error));
  return { ok: false, reason: NOT_READY };
}
