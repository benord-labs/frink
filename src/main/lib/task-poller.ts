/**
 * Task Poller Service — local SQLite poller. Replaces the cloud HTTP polling that fetched tasks
 * from Neon. Single-process, so "machine" collapses to this electron instance plus the executor.
 */

import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { getDatabase } from './db';
import { claimTask, getPendingTaskIds } from './db/repos/tasks';
import { computeExponentialBackoffMs } from './retry-backoff';

const POLL_INTERVAL_MS = 5000; // 5 seconds
const MAX_BACKOFF_MS = 30000;

class TaskPoller extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private machineId: string | null = null;
  private isPolling = false;
  private isPaused = false;
  private consecutiveFailures = 0;
  private backoffUntilMs = 0;

  /**
   * Start the polling loop
   */
  async start(): Promise<void> {
    if (this.interval) {
      return;
    }

    // Claimant label only (local SQLite claim).
    this.machineId = hostname();

    // Immediate first poll
    await this.poll();

    // Start interval
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  /**
   * Stop the polling loop
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Pause polling (e.g., when app goes to background)
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Resume polling
   */
  resume(): void {
    this.isPaused = false;
    // Immediate poll on resume
    this.poll();
  }

  /**
   * Trigger an immediate poll WITHOUT altering pause state. Latency optimization
   * for freshly-created tasks (e.g. a flow agent node) so we don't wait up to
   * POLL_INTERVAL_MS for the next tick. The poll() guards (isPaused/isPolling/
   * backoff) still apply, so this is safe to call at any time.
   */
  pokeNow(): void {
    void this.poll();
  }

  /**
   * Check if poller is running
   */
  isRunning(): boolean {
    return this.interval !== null;
  }

  /**
   * Single poll iteration
   */
  private async poll(): Promise<void> {
    if (this.isPaused || this.isPolling || !this.machineId) {
      return;
    }
    if (Date.now() < this.backoffUntilMs) {
      return;
    }

    this.isPolling = true;
    this.emit('poll:start');

    try {
      let tasks: { id: string }[];
      try {
        tasks = await getPendingTaskIds(getDatabase(), 1);
        this.resetBackoff();
      } catch (error) {
        if (error instanceof TypeError) {
          this.scheduleBackoff();
          this.emit('poll:complete', 0);
          return;
        }
        throw error;
      }

      this.emit('poll:complete', tasks.length);

      if (tasks.length === 0) {
        this.isPolling = false;
        return;
      }

      // Process first pending task (one at a time for now)
      const task = tasks[0];
      await this.processTask(task);
    } catch (error) {
      this.emit('task:error', error as Error);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Process a single task - claim it and emit for execution
   */
  private async processTask(task: { id: string }): Promise<void> {
    if (!this.machineId) return;

    try {
      // Atomic claim — prevents double-claim within this process. Single
      // electron instance owns the local DB, so cross-machine races vanish.
      const claimed = await claimTask(getDatabase(), task.id, this.machineId);

      if (!claimed) {
        return;
      }

      // Emit for execution handler (3.3 will handle this)
      this.emit('task:claimed', claimed);
    } catch (error) {
      this.emit('task:error', error as Error, task);
    }
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.backoffUntilMs = 0;
  }

  private scheduleBackoff(): void {
    this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 6);
    const retryDelayMs = computeExponentialBackoffMs(this.consecutiveFailures, {
      baseMs: POLL_INTERVAL_MS,
      maxMs: MAX_BACKOFF_MS,
      jitterMaxMs: 1000,
    });
    this.backoffUntilMs = Date.now() + retryDelayMs;
  }
}

// Singleton instance
let pollerInstance: TaskPoller | null = null;

export function getTaskPoller(): TaskPoller {
  if (!pollerInstance) {
    pollerInstance = new TaskPoller();
  }
  return pollerInstance;
}

export { TaskPoller };
