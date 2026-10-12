import { type ChildProcess, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import type { Readable } from 'node:stream';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { resolveCommandShell } from '../../platform/command-shell';

/** Claude's default `timeout` for a command hook. */
const DEFAULT_TIMEOUT_SEC = 600;
/** How long Claude waits after SIGTERM before it sends SIGKILL to a stopped hook. */
const KILL_GRACE_MS = 1500;
/** Node runs a longer timer after 1 ms, which would stop the hook at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Kept per stream; far above the 10,000 characters Claude passes on from a hook. */
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const HIGH_SURROGATE_END = /[\uD800-\uDBFF]$/;
const PROJECT_DIR = '${CLAUDE_PROJECT_DIR}';
/** Claude refuses these outside a plugin's own hooks rather than run with the path missing. */
const PLUGIN_ONLY = ['${CLAUDE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_DATA}'];

type HookCommandRun = {
  command: string;
  /** Exec form: `command` is spawned directly with these arguments, with no shell. */
  args?: string[];
  timeoutSec?: number;
  /** Written to stdin as one line of JSON, then stdin is closed. */
  input: HookInput;
  /** Where the hook process starts, which need not be the `cwd` inside `input`. */
  cwd: string;
  /** Where the session started; used when `cwd` no longer exists. */
  sessionCwd: string;
  /** `CLAUDE_PROJECT_DIR`, in the environment and in exec-form placeholders. */
  projectRoot: string;
  /** Given to the hook as is, except the `OTEL_*` names Claude removes from every subprocess. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
};

/** The raw process result; reading stdout and deciding anything is the caller's job. */
type HookCommandOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The stream wrote more than MAX_OUTPUT_CHARS; the rest was read and dropped. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Wins over `exitCode`: a hook whose child holds its output can time out after exit 0. */
  timedOut: boolean;
  /** Set when nothing ran: the process could not start, was refused, or the signal had aborted. */
  startError?: string;
};

const NO_OUTPUT = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false };
const NOT_STARTED = { exitCode: null, signal: null, ...NO_OUTPUT, timedOut: false };

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Claude's documented fallback order when the start directory no longer exists. */
async function runDirectory(run: HookCommandRun): Promise<string> {
  for (const dir of [run.cwd, run.sessionCwd, run.projectRoot, os.homedir()]) {
    if (await isDirectory(dir)) return dir;
  }
  return os.tmpdir();
}

function withProjectDir(text: string, projectRoot: string): string {
  return text.split(PROJECT_DIR).join(projectRoot);
}

function spawnHook(
  run: HookCommandRun,
  cwd: string,
  shell: string | true | undefined,
): ChildProcess {
  const env = Object.entries(run.env).filter(([name]) => !name.startsWith('OTEL_'));
  const options = {
    cwd,
    env: {
      ...Object.fromEntries(env),
      CLAUDE_PROJECT_DIR: run.projectRoot,
      ...(run.input.effort && { CLAUDE_EFFORT: run.input.effort.level }),
    },
    // Its own session: no controlling terminal, and one process group to stop.
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
  if (!run.args) return spawn(run.command, [], { ...options, shell });
  const args = run.args.map((arg) => withProjectDir(arg, run.projectRoot));
  return spawn(withProjectDir(run.command, run.projectRoot), args, options);
}

/** Signals the hook's whole process group, so a shell hook's children stop with it. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows has no process group to signal; taskkill ends the hook and its children.
    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    });
    taskkill.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function groupGone(child: ChildProcess): boolean {
  try {
    return child.pid === undefined || !process.kill(-child.pid, 0);
  } catch {
    return true;
  }
}

function killTree(child: ChildProcess): void {
  signalTree(child, 'SIGKILL');
  // A descendant that left the group may still hold the pipes; stop waiting for it.
  for (const stream of child.stdio) stream?.destroy();
}

function stopTree(child: ChildProcess): NodeJS.Timeout {
  signalTree(child, 'SIGTERM');
  return setTimeout(killTree, KILL_GRACE_MS, child).unref();
}

/** Keeps the start of a stream and reads on, so the hook never blocks on a full pipe. */
function capture(output: typeof NO_OUTPUT, name: 'stdout' | 'stderr', stream: Readable | null) {
  stream?.setEncoding('utf8').on('data', (chunk: string) => {
    if (output[`${name}Truncated`]) return;
    const room = MAX_OUTPUT_CHARS - output[name].length;
    if (chunk.length <= room) {
      output[name] += chunk;
      return;
    }
    // A cut after the first half of a surrogate pair would leave an invalid character.
    const kept = chunk.slice(0, room);
    output[name] += HIGH_SURROGATE_END.test(kept) ? kept.slice(0, -1) : kept;
    output[`${name}Truncated`] = true;
  });
}

function collect(child: ChildProcess, run: HookCommandRun): Promise<HookCommandOutcome> {
  const output = { ...NO_OUTPUT };
  capture(output, 'stdout', child.stdout);
  capture(output, 'stderr', child.stderr);
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  // A hook may exit without reading its input; the broken pipe is not an error.
  child.stdin?.on('error', () => {});
  child.stdin?.end(`${JSON.stringify(run.input)}\n`);

  const stop = () => (killTimer ??= stopTree(child));
  // Like Claude, a zero or missing timeout means the default.
  const timeoutMs = Math.min((run.timeoutSec || DEFAULT_TIMEOUT_SEC) * 1000, MAX_TIMER_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  run.signal.addEventListener('abort', stop, { once: true });
  // An abort that landed before the listener was added would otherwise be missed.
  if (run.signal.aborted) stop();

  return new Promise((resolve) => {
    const finish = (outcome: HookCommandOutcome) => {
      clearTimeout(timer);
      run.signal.removeEventListener('abort', stop);
      // Keep the SIGKILL only while something in the group outlives the hook.
      if (killTimer && groupGone(child)) clearTimeout(killTimer);
      resolve(outcome);
    };
    // Node reports a failed kill as a later `error`, which must not go unhandled.
    child.on('error', (error) => {
      if (child.pid === undefined) finish({ ...NOT_STARTED, startError: error.message });
    });
    child.once('close', (exitCode, signal) => finish({ exitCode, signal, ...output, timedOut }));
  });
}

/** Runs one command hook the way Claude Code does; resolves once its output closes, never throws. */
export async function runHookCommand(run: HookCommandRun): Promise<HookCommandOutcome> {
  try {
    const shell = run.args ? undefined : ((await resolveCommandShell()) ?? true);
    const cwd = await runDirectory(run);
    run.signal.throwIfAborted();
    const texts = [run.command, ...(run.args ?? [])];
    const refused = PLUGIN_ONLY.find((name) => texts.some((text) => text.includes(name)));
    if (refused) throw new Error(`Hook command references ${refused} but is not a plugin's hook`);
    return await collect(spawnHook(run, cwd, shell), run);
  } catch (error) {
    return { ...NOT_STARTED, startError: error instanceof Error ? error.message : String(error) };
  }
}
