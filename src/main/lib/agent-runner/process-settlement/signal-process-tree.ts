import { type ChildProcess, spawn } from 'node:child_process';

/** Signals the child's whole process group, so the processes it started stop with it. */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows has no process group to signal; taskkill ends the child and its descendants.
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

/** Force-stops the child's process group and stops waiting on its pipes. */
export function killProcessTree(child: ChildProcess): void {
  signalProcessTree(child, 'SIGKILL');
  // A descendant that left the group may still hold the pipes; stop waiting for it.
  for (const stream of child.stdio) stream?.destroy();
}

/** True once nothing is left in the child's process group, or it never started. */
export function processTreeGone(child: ChildProcess): boolean {
  try {
    return child.pid === undefined || !process.kill(-child.pid, 0);
  } catch {
    return true;
  }
}
