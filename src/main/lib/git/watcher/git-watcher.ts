import { EventEmitter } from 'node:events';
import type { AsyncSubscription } from '@parcel/watcher';
import log from 'electron-log';
import { isGitPointerRelatedPath } from './git-head-path';

// Simple debounce implementation to avoid lodash-es dependency in main process
function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;
  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), wait);
  };
}

type FileChangeType = 'add' | 'change' | 'unlink';

type FileChange = {
  path: string;
  type: FileChangeType;
};

export type GitWatchEvent = {
  type: 'batch';
  changes: FileChange[];
  timestamp: number;
  worktreePath: string;
};

const BACKSLASH_RE = /\\/g;
const IGNORED_WATCHER_PATH_SEGMENTS = [
  '/node_modules/',
  '/.git/',
  '/dist/',
  '/build/',
  '/.next/',
  '/.cache/',
  '/coverage/',
  '/.turbo/',
  '/.vite/',
  '/.parcel-cache/',
  '/out/',
] as const;

export function shouldProcessWatcherPath(eventPath: string): boolean {
  const normalizedPath = eventPath.replace(BACKSLASH_RE, '/');

  // Always allow git pointer/index updates that affect worktree status after external git ops.
  if (isGitPointerRelatedPath(eventPath)) {
    return true;
  }

  for (const ignoredPath of IGNORED_WATCHER_PATH_SEGMENTS) {
    if (normalizedPath.includes(ignoredPath)) {
      return false;
    }
  }

  return true;
}

type GitWatcherConfig = {
  worktreePath: string;
  debounceMs?: number;
};

/**
 * GitWatcher monitors a worktree directory for file changes using @parcel/watcher (same as VS Code).
 * Changes are batched and debounced to avoid overwhelming the renderer with events.
 */
class GitWatcher extends EventEmitter {
  private watcher: AsyncSubscription | null = null;
  private worktreePath: string;
  private pendingChanges: Map<string, FileChangeType> = new Map();
  private isDisposed = false;
  private debounceMs: number;
  private initPromise: Promise<void>;
  private flushChanges: () => void;

  constructor(config: GitWatcherConfig) {
    super();
    this.worktreePath = config.worktreePath;
    this.debounceMs = config.debounceMs ?? 300; // 300ms debounce for file changes (VS Code uses ~200-500ms)

    // Create debounced flush function
    this.flushChanges = debounce(() => {
      if (this.isDisposed || this.pendingChanges.size === 0) return;

      const changes: FileChange[] = Array.from(this.pendingChanges.entries()).map(
        ([path, type]) => ({
          path,
          type,
        }),
      );

      this.pendingChanges.clear();

      const event: GitWatchEvent = {
        type: 'batch',
        changes,
        timestamp: Date.now(),
        worktreePath: this.worktreePath,
      };

      this.emit('change', event);
    }, this.debounceMs);

    this.initPromise = this.initWatcher(config);
  }

  private async initWatcher(config: GitWatcherConfig): Promise<void> {
    // Use @parcel/watcher - same as VS Code
    const watcher = await import('@parcel/watcher');

    // Watch entire worktree (subscribe: dir, callback; options omitted for type compatibility)
    const subscription = await watcher.subscribe(config.worktreePath, (err, events) => {
      if (err) {
        this.emit('error', err);
        return;
      }

      // Filter out ignored paths at the application level (parcel-watcher has no ignore option).
      const filteredEvents = events.filter((event) => shouldProcessWatcherPath(event.path));

      if (filteredEvents.length === 0) return;

      // Map parcel-watcher events to our event types
      for (const event of filteredEvents) {
        const type: FileChangeType =
          event.type === 'create' ? 'add' : event.type === 'update' ? 'change' : 'unlink';
        this.pendingChanges.set(event.path, type);
      }

      this.flushChanges();
    });

    this.watcher = subscription;
  }

  /**
   * Wait for the watcher to be initialized.
   */
  async waitForReady(): Promise<void> {
    await this.initPromise;
  }

  getWorktreePath(): string {
    return this.worktreePath;
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Wait for init to complete before disposing
    await this.initPromise.catch(() => {});

    await this.watcher?.unsubscribe();
    this.pendingChanges.clear();
    this.removeAllListeners();
  }
}

/**
 * Registry for managing multiple GitWatcher instances (one per worktree).
 * Ensures only one watcher exists per worktree path.
 */
class GitWatcherRegistry {
  private watchers: Map<string, GitWatcher> = new Map();
  private listeners: Map<string, Set<(event: GitWatchEvent) => void>> = new Map();

  /**
   * Get or create a watcher for the given worktree path.
   * If a watcher already exists, returns the existing one.
   */
  async getOrCreate(worktreePath: string): Promise<GitWatcher> {
    let watcher = this.watchers.get(worktreePath);
    if (!watcher) {
      watcher = new GitWatcher({
        worktreePath,
        debounceMs: 300, // 300ms debounce for file changes (VS Code uses ~200-500ms)
      });
      this.watchers.set(worktreePath, watcher);

      // Wire up event forwarding
      watcher.on('change', (event: GitWatchEvent) => {
        const listeners = this.listeners.get(worktreePath);
        if (listeners) {
          const callbacks = Array.from(listeners);
          for (const callback of callbacks) {
            try {
              callback(event);
            } catch (_error) {}
          }
        }
      });

      // Must have an 'error' listener — otherwise EventEmitter turns emit('error', ...)
      // into an uncaughtException. @parcel/watcher surfaces recoverable FSEvents
      // queue-overflow here ("Events were dropped ... re-scanned"); future events
      // still come through, so log and continue.
      watcher.on('error', (error: Error) => {
        log.warn('[GitWatcher]', worktreePath, error.message);
      });

      // Wait for the watcher to be ready
      await watcher.waitForReady();
    }
    return watcher;
  }

  /**
   * Subscribe to file change events for a worktree.
   * Returns an unsubscribe function.
   *
   * NOTE: This is async to ensure the watcher is ready before returning.
   * This prevents race conditions where events could be missed if the
   * callback is added before the watcher finishes initializing.
   */
  async subscribe(
    worktreePath: string,
    callback: (event: GitWatchEvent) => void,
  ): Promise<() => void> {
    // Wait for watcher to be ready before adding listener
    await this.getOrCreate(worktreePath);

    // Add listener
    let listeners = this.listeners.get(worktreePath);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(worktreePath, listeners);
    }
    listeners.add(callback);

    // Return unsubscribe function
    return () => {
      listeners?.delete(callback);
      // Keep watcher alive for potential reuse
    };
  }

  /**
   * Check if a watcher exists for the given worktree.
   */
  has(worktreePath: string): boolean {
    return this.watchers.has(worktreePath);
  }

  /**
   * Dispose a specific watcher.
   */
  async dispose(worktreePath: string): Promise<void> {
    const watcher = this.watchers.get(worktreePath);
    if (watcher) {
      await watcher.dispose();
      this.watchers.delete(worktreePath);
      this.listeners.delete(worktreePath);
    }
  }

  /**
   * Dispose all watchers. Call this when the app is shutting down.
   */
  async disposeAll(): Promise<void> {
    const disposals = Array.from(this.watchers.values()).map((watcher) => watcher.dispose());
    await Promise.all(disposals);
    this.watchers.clear();
    this.listeners.clear();
  }

  /**
   * Get the number of active watchers.
   */
  getWatcherCount(): number {
    return this.watchers.size;
  }
}

// Singleton instance
export const gitWatcherRegistry = new GitWatcherRegistry();
