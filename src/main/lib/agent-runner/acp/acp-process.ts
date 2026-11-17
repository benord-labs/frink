import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import log from 'electron-log';
import { lowerChildPriority } from '../../platform/lower-child-priority';
import { killProcessTree, processTreeGone, signalProcessTree } from '../process-settlement';
import type { AcpAgentRules } from './acp-permissions';

/** How to start one agent in ACP mode. The caller supplies it; nothing here knows any agent. */
export type AcpAgentLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  rules: AcpAgentRules;
  /** The command that signs the user in to the agent, shown when the agent asks for a sign-in. */
  signInHint?: string;
  /** The folder the agent's shell gate reads the commands Frink allowed from. */
  commandLedger?: string;
  /** Removes what the launch set up, once the agent has stopped. */
  cleanup?: () => Promise<void>;
};

export type AcpAgentProcess = {
  /** The agent's stdin and stdout, which carry its ACP messages. */
  stdio: { input: WritableStream<Uint8Array>; output: ReadableStream<Uint8Array> };
  /** Settles once the process has ended and its output has been read, or it could not start. */
  closed: Promise<void>;
  /** How the process ended and the last of its stderr, to explain a dropped connection. */
  describeExit: () => string;
  /** Stops the agent's whole process group, force-stopping it after `graceMs`; settles once it is gone. */
  dispose: (graceMs?: number) => Promise<void>;
};

const STDERR_TAIL_CHARS = 2000;
/** The most of the agent's last error line a person is shown; the whole tail goes to the log. */
const SHOWN_STDERR_CHARS = 200;
/** Time the agent gets to stop on its own before its process group is killed. */
const STOP_GRACE_MS = 1500;
const STOP_TIMEOUT_MS = 5000;
const STOP_POLL_MS = 25;

/** Agents not yet stopped, so quitting Frink can stop them all. */
const liveAgents = new Set<AcpAgentProcess>();

async function treeGoneWithin(child: ChildProcess, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (!processTreeGone(child)) {
    if (Date.now() >= deadline) return false;
    await sleep(STOP_POLL_MS);
  }
  return true;
}

/** Asks the group to stop, then force-stops whatever is left, even after the agent itself exited. */
async function stopProcessTree(
  child: ChildProcess,
  closed: Promise<void>,
  graceMs: number,
): Promise<void> {
  signalProcessTree(child, 'SIGTERM');
  await treeGoneWithin(child, graceMs);
  killProcessTree(child);
  if (!(await treeGoneWithin(child, STOP_TIMEOUT_MS))) {
    throw new Error('The agent process did not stop');
  }
  await closed;
}

export function startAcpAgentProcess(launch: AcpAgentLaunch): AcpAgentProcess {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so a launcher such as npx stops together with the agent it starts.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  lowerChildPriority(child.pid);
  let stderrTail = '';
  let ending = '';
  let stopped: Promise<void> | undefined;
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
  });
  child.once('exit', (code, signal) => {
    ending = signal ? `stopped by ${signal}` : `exited with code ${code}`;
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      if (!stopped && stderrTail) log.warn(`[ACP] Agent ${ending}; its error output:`, stderrTail);
      resolve();
    });
    child.once('error', (error) => {
      ending = `could not start: ${error.message}`;
      resolve();
    });
  });
  // A write after the agent has gone arrives as a stream error, which must not go unhandled.
  child.stdin.on('error', () => {});

  // SAFETY: a child's stdout yields bytes; Node types its web stream more loosely than the DOM's.
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const agent: AcpAgentProcess = {
    stdio: { input: Writable.toWeb(child.stdin), output },
    closed,
    describeExit: () => {
      const lastLine = stderrTail.trim().split('\n').at(-1)?.slice(0, SHOWN_STDERR_CHARS);
      return [ending, lastLine].filter(Boolean).join(': ');
    },
    dispose: (graceMs = STOP_GRACE_MS) =>
      (stopped ??= stopProcessTree(child, closed, graceMs).finally(() => liveAgents.delete(agent))),
  };
  liveAgents.add(agent);
  return agent;
}

/** Stops every agent still running, for when Frink quits. */
export async function disposeAllAcpAgents(): Promise<void> {
  await Promise.allSettled([...liveAgents].map((agent) => agent.dispose()));
}
