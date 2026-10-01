import os from 'node:os';

/** Runs an agent or Flow command, and every process it spawns, below the app's CPU priority, so a
 * saturated machine slows the agents before it starves the main thread that owns the window. */
export function lowerChildPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // The child already exited, so its priority no longer matters.
  }
}
