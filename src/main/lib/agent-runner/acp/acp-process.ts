import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { killProcessTree, processTreeGone, signalProcessTree } from '../process-settlement';

/** How to start one agent in ACP mode. The caller supplies it; nothing here knows any agent. */
export type AcpAgentLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type AcpAgentProcess = {
  /** ACP messages over the agent's stdin and stdout. */
  stream: Stream;
  /** Settles once the process has ended and its output has been read, or it could not start. */
  closed: Promise<void>;
  /** How the process ended and the last of its stderr, to explain a dropped connection. */
  describeExit: () => string;
  /** Stops the agent's whole process group; settles once nothing is left of it. */
  dispose: () => Promise<void>;
};

const STDERR_TAIL_CHARS = 2000;
/** Time the agent gets to stop on its own before its process group is killed. */
const STOP_GRACE_MS = 1500;
const STOP_TIMEOUT_MS = 5000;
const STOP_POLL_MS = 25;

async function treeGoneWithin(child: ChildProcess, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (!processTreeGone(child)) {
    if (Date.now() >= deadline) return false;
    await sleep(STOP_POLL_MS);
  }
  return true;
}

/** Asks the group to stop, then force-stops whatever is left, even after the agent itself exited. */
async function stopProcessTree(child: ChildProcess, closed: Promise<void>): Promise<void> {
  signalProcessTree(child, 'SIGTERM');
  await treeGoneWithin(child, STOP_GRACE_MS);
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
  let stderrTail = '';
  let ending = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
  });
  child.once('exit', (code, signal) => {
    ending = signal ? `stopped by ${signal}` : `exited with code ${code}`;
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', resolve);
    child.once('error', (error) => {
      ending = `could not start: ${error.message}`;
      resolve();
    });
  });
  // A write after the agent has gone arrives as a stream error, which must not go unhandled.
  child.stdin.on('error', () => {});

  // SAFETY: a child's stdout yields bytes; Node types its web stream more loosely than the DOM's.
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  let stopped: Promise<void> | undefined;
  return {
    stream: ndJsonStream(Writable.toWeb(child.stdin), output),
    closed,
    describeExit: () => [ending, stderrTail.trim()].filter(Boolean).join(': '),
    dispose: () => (stopped ??= stopProcessTree(child, closed)),
  };
}
