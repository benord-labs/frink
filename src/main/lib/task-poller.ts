/**
 * Task Poller Service — local SQLite poller. Replaces the cloud HTTP polling that fetched tasks
 * from Neon. Single-process, so "machine" collapses to this electron instance plus the executor.
 */

import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import log from 'electron-log';
import { getDatabase } from './db';
import { claimTask, getPendingTaskIds } from './db/repos/tasks';
import { computeExponentialBackoffMs } from './retry-backoff';

const POLL_INTERVAL_MS = 5000; // 5 seconds
const MAX_BACKOFF_MS = 30000;
const BACKOFF_JITTER_MAX_MS = 1000;

export type TaskPollerDeps = {
  getDatabase: typeof getDatabase;
  getPendingTaskIds: typeof getPendingTaskIds;
  claimTask: typeof claimTask;
  log: Pick<typeof log, 'warn' | 'error'>;
};

const defaultDeps: TaskPollerDeps = { getDatabase, getPendingTaskIds, claimTask, log };

class TaskPoller extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private machineId: string | null = null;
  private isPolling = false;
  private isPaused = false;
  private consecutiveFailures = 0;
  private backoffUntilMs = 0;

  constructor(private readonly deps: TaskPollerDeps = defaultDeps) {
    super();
  }

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
    // Monotonic clock: a wall-clock jump (NTP, manual change) must not stretch or cancel a backoff.
    if (performance.now() < this.backoffUntilMs) {
      return;
    }

    this.isPolling = true;
    this.emitSafely('poll:start');

    try {
      let tasks: { id: string }[];
      try {
        tasks = await this.deps.getPendingTaskIds(this.deps.getDatabase(), 1);
      } catch (error) {
        // Any failure to read the queue (SQLITE_BUSY, disk I/O, DB init/migration)
        // backs off — retrying every tick would hammer a failing database.
        this.deps.log.warn(
          '[task-poller] Failed to fetch pending tasks; backing off',
          this.scheduleBackoff(),
          error,
        );
        this.emitSafely('task:error', error);
        this.emitSafely('poll:complete', 0);
        return;
      }

      this.emitSafely('poll:complete', tasks.length);

      if (tasks.length === 0) {
        this.resetBackoff();
        return;
      }

      // Process first pending task (one at a time for now)
      const task = tasks[0];
      await this.processTask(task);
    } catch (error) {
      this.emitSafely('task:error', error);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Process a single task - claim it and emit for execution
   */
  private async processTask(task: { id: string }): Promise<void> {
    if (!this.machineId) return;

    let claimed: Awaited<ReturnType<TaskPollerDeps['claimTask']>>;
    try {
      // Atomic claim — prevents double-claim within this process. Single
      // electron instance owns the local DB, so cross-machine races vanish.
      claimed = await this.deps.claimTask(this.deps.getDatabase(), task.id, this.machineId);
    } catch (error) {
      // The claim is a DB write, so it fails the same way the read does.
      this.deps.log.warn(
        '[task-poller] Failed to claim task; backing off',
        this.scheduleBackoff(),
        error,
      );
      this.emitSafely('task:error', error, task);
      return;
    }
    this.resetBackoff();

    if (!claimed) {
      return;
    }

    try {
      // Emit for execution handler (3.3 will handle this)
      this.emit('task:claimed', claimed);
    } catch (error) {
      this.emitSafely('task:error', error, task);
    }
  }

  // A throwing listener must not reject poll(): on the first poll that would reject
  // start() before the interval exists, so polling would never start.
  private emitSafely(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (listenerError) {
      this.deps.log.error(`[task-poller] A '${event}' listener threw`, listenerError);
    }
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.backoffUntilMs = 0;
  }

  private scheduleBackoff() {
    this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 6);
    const retryDelayMs = computeExponentialBackoffMs(this.consecutiveFailures, {
      baseMs: POLL_INTERVAL_MS,
      maxMs: MAX_BACKOFF_MS,
      jitterMaxMs: BACKOFF_JITTER_MAX_MS,
    });
    this.backoffUntilMs = performance.now() + retryDelayMs;
    return { consecutiveFailures: this.consecutiveFailures, retryInMs: retryDelayMs };
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
