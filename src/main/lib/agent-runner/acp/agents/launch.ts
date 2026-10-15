import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import { ensureLoginShellEnv, getLoginShellEnvSync } from '../../../platform/login-shell-env';
import { killProcessTree } from '../../process-settlement';
import { commandGateScript } from '../acp-command-ledger';
import type { AcpAgentRules } from '../acp-permissions';
import type { AcpAgentLaunch } from '../acp-process';

type Env = Record<string, string>;

/** What one launch gives an agent's settings: its private folders, shell gate and password. */
export type LaunchContext = {
  /** Fresh, private folders for this launch only. */
  dirs: { config: string; home: string };
  shellGate: string;
  /** Minted for this launch; it must never reach a command the agent runs. */
  password: string;
  /** The folder whose instructions the agent follows. */
  projectRoot: string;
  /** The user's own environment, for where their real settings live. */
  userEnv: Env;
};

type CheckOutput = { stdout: string; stderr: string };

/** A run of the agent before it starts, whether its output lets the launch go ahead, and why not. */
export type LaunchCheck = {
  args: readonly string[];
  passes: (output: CheckOutput) => boolean;
  refusal?: string;
};

/** The agent's settings for one launch, and the checks that its effective settings still hold them. */
type LaunchSettings = { env: Env; checks: readonly LaunchCheck[] };

/** How Frink starts one agent so that it asks before it acts. */
export type AcpLaunchRow = {
  name: string;
  binary: string;
  /** Usual install places tried after PATH, relative to the home folder. */
  fallbacks: readonly string[];
  /** The checked versions: at least `floor`, below `below`. */
  versions: { floor: string; below: string };
  /** Picks the version out of `--version` output as its first group; else the whole output is it. */
  versionPattern?: RegExp;
  installHint: string;
  signInHint: string;
  args: readonly string[];
  /** Inherited variables with this prefix are the agent's own settings, so they are dropped. */
  envPrefix: string;
  rules: AcpAgentRules;
  settings: (context: LaunchContext) => Promise<LaunchSettings>;
};

/** What finding an installed agent and reading its version needs. */
export type InstalledAgentRow = Pick<
  AcpLaunchRow,
  'name' | 'binary' | 'fallbacks' | 'versions' | 'versionPattern' | 'installHint'
>;

export type AcpLaunchResult =
  | { ok: true; launch: Omit<AcpAgentLaunch, 'cwd'> }
  | { ok: false; reason: string };

export type LaunchOptions = {
  /** The project whose instructions apply; defaults to the chat's folder. */
  configRoot?: string;
  /** Where launches keep their private folders; defaults to Frink's own data folder. */
  runRoot?: string;
  /** The environment to start from; defaults to the user's login shell. */
  env?: Env;
  /** Time limit for each check run before the agent starts. */
  checkTimeoutMs?: number;
};

const VERSION_TIMEOUT_MS = 5_000;
const SETTINGS_TIMEOUT_MS = 15_000;
const MAX_CHECK_OUTPUT_CHARS = 1024 * 1024;
/** Shells the agent treats as POSIX, so it calls the gate with `-c <command>`. */
const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh']);
const sweptRunRoots = new Map<string, Promise<void>>();

export async function userEnv(): Promise<Env> {
  await ensureLoginShellEnv();
  const loginEnv = getLoginShellEnvSync();
  if (loginEnv) return loginEnv;
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

async function isProgram(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function firstProgram(candidates: string[]): Promise<string | undefined> {
  for (const file of candidates) if (await isProgram(file)) return file;
  return undefined;
}

/** The agent on absolute PATH entries, then its usual install places; never a relative entry. */
async function locateBinary(row: InstalledAgentRow, env: Env): Promise<string | undefined> {
  const home = env.HOME ?? os.homedir();
  const onPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, row.binary));
  return firstProgram([...onPath, ...row.fallbacks.map((file) => path.join(home, file))]);
}

/** The shell the agent's commands really run in, mirroring how the agent picks one itself. */
async function realShell(env: Env): Promise<string> {
  const login = env.SHELL;
  if (login && POSIX_SHELLS.has(path.basename(login)) && (await isProgram(login))) return login;
  if (process.platform === 'darwin') return '/bin/zsh';
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  return (await firstProgram(pathDirs.map((dir) => path.join(dir, 'bash')))) ?? '/bin/sh';
}

function runCheck(file: string, args: readonly string[], env: Env, cwd: string, timeout: number) {
  // Its own process group, so a timeout also stops what it started, like the CLI an npm loader runs.
  const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32' });
  const timer = setTimeout(killProcessTree, timeout, child);
  const output = { stdout: '', stderr: '' };
  // A broken program that prints without end is stopped rather than read into memory.
  const keep = (name: keyof CheckOutput) => (text: string) => {
    output[name] += text;
    if (output.stdout.length + output.stderr.length > MAX_CHECK_OUTPUT_CHARS)
      killProcessTree(child);
  };
  child.stdout.setEncoding('utf8').on('data', keep('stdout'));
  child.stderr.setEncoding('utf8').on('data', keep('stderr'));
  return new Promise<CheckOutput>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(file)} ${args.join(' ')} ended: ${signal ?? code}`));
    });
  });
}

function versionParts(text: string, pattern?: RegExp): number[] | undefined {
  const version = pattern ? (pattern.exec(text)?.[1] ?? '') : text;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  const differing = a.findIndex((part, index) => part !== b[index]);
  return differing === -1 ? 0 : (a[differing] ?? 0) - (b[differing] ?? 0);
}

function holds(version: number[], { floor, below }: InstalledAgentRow['versions']): boolean {
  const [low, high] = [versionParts(floor), versionParts(below)];
  return (
    !!low && !!high && compareVersions(version, low) >= 0 && compareVersions(version, high) < 0
  );
}

/** The row whose checked versions hold the installed one, else why the agent may not start. */
async function checkVersion<Row extends InstalledAgentRow>(
  rows: readonly Row[],
  command: string,
  env: Env,
  cwd: string,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<{ row: Row; version: string } | { reason: string }> {
  const { name, versionPattern } = rows[0];
  const output = await runCheck(command, ['--version'], env, cwd, timeoutMs).catch((error) => {
    log.warn(`[ACP] ${name} --version failed`, error);
    return { stdout: '' };
  });
  const version = versionParts(output.stdout, versionPattern);
  if (!version) {
    return {
      reason: `Frink couldn't tell which version of ${name} you have, so it didn't start it.`,
    };
  }
  const row = rows.find((candidate) => holds(version, candidate.versions));
  if (row) return { row, version: version.join('.') };
  const floors = rows.map((candidate) => versionParts(candidate.versions.floor) ?? []);
  // A floor inside a minor is named in full, so an older patch of it is not called checked.
  const checked = floors.map((floor) => {
    const minor = floor.slice(0, 2).join('.');
    return floor[2] ? `${floor.join('.')} and later ${minor} releases` : minor;
  });
  const newest = floors[floors.length - 1];
  const fix =
    compareVersions(version, newest) < 0
      ? `Update ${name}, then try again.`
      : `To use ${name} in Frink now, go back to ${name} ${newest.slice(0, 2).join('.')}.`;
  const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(checked);
  return {
    reason: `Frink has checked ${name} ${list}. You have ${version.join('.')}, which Frink hasn't checked yet. ${fix}`,
  };
}

/** Why the agent's effective settings may not run, or undefined when every check passes. */
async function checkSettings(
  row: AcpLaunchRow,
  command: string,
  settings: LaunchSettings,
  env: Env,
  cwd: string,
  timeoutMs = SETTINGS_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    // One at a time: the agent's runs share its database, and none may outlive a refusal.
    for (const { args, passes, refusal } of settings.checks) {
      if (passes(await runCheck(command, args, env, cwd, timeoutMs))) continue;
      // The settings themselves are never logged: they may hold the user's keys.
      log.warn(`[ACP] ${row.name}'s effective settings may change how it asks for permission`);
      return (
        refusal ??
        `Settings from an organisation, sign-in provider or administrator can change how ${row.name} asks for permission, so Frink can't run it safely.`
      );
    }
    return undefined;
  } catch (error) {
    // A parse error quotes the output, which may hold the user's keys, so only its kind is logged.
    const logged = error instanceof SyntaxError ? error.name : error;
    log.warn(`[ACP] Could not read ${row.name}'s effective settings`, logged);
    return `Frink couldn't check ${row.name}'s settings, so it didn't start it.`;
  }
}

/** Removes run folders a previous run of Frink left behind, once per run of Frink. */
function sweepRunRoot(runRoot: string): Promise<void> {
  let swept = sweptRunRoots.get(runRoot);
  if (!swept) {
    swept = rm(runRoot, { recursive: true, force: true }).catch((error) =>
      log.warn('[ACP] Could not remove earlier launch folders', error),
    );
    sweptRunRoots.set(runRoot, swept);
  }
  return swept;
}

/** A fresh private folder for one launch, with the folders the agent and its shell gate use. */
async function createRunDir(runRoot: string) {
  await sweepRunRoot(runRoot);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(`${runRoot}${path.sep}`);
  const dirs = {
    root,
    config: path.join(root, 'config'),
    home: path.join(root, 'home'),
    shell: path.join(root, 'shell'),
    ledger: path.join(root, 'ledger'),
  };
  for (const dir of [dirs.config, dirs.home, dirs.shell, dirs.ledger]) {
    await mkdir(dir, { mode: 0o700 });
  }
  return dirs;
}

function withoutPrefix(env: Env, prefix: string): Env {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith(prefix)));
}

/** Where the agent is installed, without starting it. */
export async function locateRowBinary(
  row: InstalledAgentRow,
  env?: Env,
): Promise<string | undefined> {
  return locateBinary(row, env ?? (await userEnv()));
}

/** The installed agent and its version, when one of its rows holds that version. */
export async function findRowBinary(
  rows: readonly InstalledAgentRow[],
  startEnv?: Env,
): Promise<{ path: string; version: string } | { reason: string; missing?: true }> {
  const env = startEnv ?? (await userEnv());
  const command = await locateBinary(rows[0], env);
  if (!command) return { reason: missingText(rows[0]), missing: true };
  const checked = await checkVersion(rows, command, env, env.HOME ?? os.homedir());
  return 'version' in checked ? { path: command, version: checked.version } : checked;
}

function missingText(row: InstalledAgentRow): string {
  return `Frink can't find ${row.name} on this computer. Install it with ${row.installHint}, then try again.`;
}

/** Prepares one launch with the row for the installed version, refusing when it cannot ask first. */
export async function launchFromRows(
  rows: readonly AcpLaunchRow[],
  cwd: string,
  options: LaunchOptions = {},
): Promise<AcpLaunchResult> {
  const env = options.env ?? (await userEnv());
  const command = await locateBinary(rows[0], env);
  if (!command) return { ok: false, reason: missingText(rows[0]) };
  const timeout = options.checkTimeoutMs;
  // The version picks the row, so no row's settings, files or checks exist before it is read.
  const versionEnv = withoutPrefix(env, rows[0].envPrefix);
  const picked = await checkVersion(rows, command, versionEnv, cwd, timeout);
  if ('reason' in picked) return { ok: false, reason: picked.reason };
  const { row } = picked;
  const runRoot = options.runRoot ?? path.join(app.getPath('userData'), 'acp', 'run');
  const dirs = await createRunDir(runRoot);
  const cleanup = () => rm(dirs.root, { recursive: true, force: true });
  try {
    const shell = await realShell(env);
    const shellGate = path.join(dirs.shell, path.basename(shell));
    const settings = await row.settings({
      dirs,
      shellGate,
      password: randomBytes(32).toString('hex'),
      projectRoot: options.configRoot ?? cwd,
      userEnv: env,
    });
    // Commands get the user's own values back, so nothing set for the agent reaches them.
    const restore = Object.fromEntries(
      Object.keys(settings.env).map((key) => [key, env[key] ?? null]),
    );
    const script = commandGateScript({ realShell: shell, ledgerDir: dirs.ledger, restore });
    await writeFile(shellGate, script, { mode: 0o700 });
    const launchEnv = { ...withoutPrefix(env, row.envPrefix), ...settings.env };
    const reason = await checkSettings(row, command, settings, launchEnv, cwd, timeout);
    if (reason) {
      await cleanup();
      return { ok: false, reason };
    }
    const { rules, signInHint } = row;
    const launch = { command, args: [...row.args], env: launchEnv, rules, signInHint };
    return { ok: true, launch: { ...launch, commandLedger: dirs.ledger, cleanup } };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
