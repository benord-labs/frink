import { EventEmitter } from 'node:events';
import type { AsyncSubscription, SubscribeCallback } from '@parcel/watcher';
import log from 'electron-log';
import { isGitDirPointerFile, resolveGitDir } from './git-dir';
import { isGitIndexPath, isGitPointerRelatedPath } from './git-head-path';
import { findIdeConfigPattern } from './ide-config-path';
import { createIgnoreFilter, type IgnoreFilter } from './ignored-paths';

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
const GITIGNORE_FILE_RE = /(?:^|\/)\.gitignore$/;
/** Git dir contents no watcher consumer reads; skipped so object writes cost nothing. */
const GIT_DIR_IGNORES = ['objects', 'worktrees', 'logs', 'lfs', 'modules'];
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
  /** A linked worktree's HEAD and index live in the main repository, outside the watched tree. */
  private gitDirWatcher: AsyncSubscription | null = null;
  /** Null outside a git repository, where nothing can be ignored. */
  private ignoreFilter: IgnoreFilter | null = null;
  private isFlushing = false;
  /** Symlink-resolved worktree path, the form event paths arrive in. */
  private worktreeRoot: string;
  private worktreePath: string;
  private pendingChanges: Map<string, FileChangeType> = new Map();
  private isDisposed = false;
  private debounceMs: number;
  private initPromise: Promise<void>;
  private flushChanges: () => void;

  constructor(config: GitWatcherConfig) {
    super();
    this.worktreePath = config.worktreePath;
    this.worktreeRoot = config.worktreePath;
    this.debounceMs = config.debounceMs ?? 300; // 300ms debounce for file changes (VS Code uses ~200-500ms)

    this.flushChanges = debounce(() => {
      void this.flush();
    }, this.debounceMs);

    this.initPromise = this.initWatcher(config);
  }

  /** Emits the pending batch minus the paths the repository ignores. One flush runs at a time. */
  private async flush(): Promise<void> {
    if (this.isDisposed || this.isFlushing || this.pendingChanges.size === 0) return;
    this.isFlushing = true;
    const batch = this.pendingChanges;
    this.pendingChanges = new Map();

    const changes = await this.dropIgnoredChanges(batch);
    this.isFlushing = false;
    if (this.isDisposed) return;

    if (changes.length > 0) {
      const event: GitWatchEvent = {
        type: 'batch',
        changes,
        timestamp: Date.now(),
        worktreePath: this.worktreePath,
      };
      this.emit('change', event);
    }
    // Events that arrived during the ignore check
    if (this.pendingChanges.size > 0) this.flushChanges();
  }

  private async dropIgnoredChanges(batch: Map<string, FileChangeType>): Promise<FileChange[]> {
    const changes: FileChange[] = Array.from(batch.entries()).map(([path, type]) => ({
      path,
      type,
    }));
    const ignoreFilter = this.ignoreFilter;
    if (!ignoreFilter) return changes;

    // Git pointers and IDE config drive more than git status, so they pass even when ignored.
    const alwaysPasses = (filePath: string) =>
      isGitPointerRelatedPath(filePath) ||
      findIdeConfigPattern(this.worktreeRoot, filePath) !== null;
    const changesIgnoreRules = (filePath: string) =>
      isGitIndexPath(filePath) || GITIGNORE_FILE_RE.test(filePath.replace(BACKSLASH_RE, '/'));

    if (changes.some((change) => changesIgnoreRules(change.path))) ignoreFilter.reset();
    // Only edits are dropped: an ignored file appearing or going still changes the file tree.
    const candidates = new Set(
      changes
        .filter((change) => change.type === 'change' && !alwaysPasses(change.path))
        .map((change) => change.path),
    );
    const kept = new Set(await ignoreFilter.keepUnignored([...candidates]));
    return changes.filter((change) => !candidates.has(change.path) || kept.has(change.path));
  }

  private async initWatcher(config: GitWatcherConfig): Promise<void> {
    // Use @parcel/watcher - same as VS Code
    const watcher = await import('@parcel/watcher');

    const onEvents =
      (accepts: (filePath: string) => boolean): SubscribeCallback =>
      (err, events) => {
        if (err) {
          this.emit('error', err);
          return;
        }

        // Cheap path filter first; the repository's own ignore rules apply at flush.
        const filteredEvents = events.filter((event) => accepts(event.path));

        if (filteredEvents.length === 0) return;

        // Map parcel-watcher events to our event types
        for (const event of filteredEvents) {
          const type: FileChangeType =
            event.type === 'create' ? 'add' : event.type === 'update' ? 'change' : 'unlink';
          // A file created and then written in one batch still counts as created
          const isFollowUpWrite =
            type === 'change' && this.pendingChanges.get(event.path) === 'add';
          this.pendingChanges.set(event.path, isFollowUpWrite ? 'add' : type);
        }

        this.flushChanges();
      };

    this.watcher = await watcher.subscribe(config.worktreePath, onEvents(shouldProcessWatcherPath));

    const gitDir = await resolveGitDir(config.worktreePath);
    if (!gitDir) return;
    this.worktreeRoot = gitDir.worktreeRoot;
    this.ignoreFilter = createIgnoreFilter(gitDir.worktreeRoot);
    if (!gitDir.outsideWorktree) return;
    // Linked worktrees, submodules and separate git dirs keep HEAD, index and refs elsewhere
    this.gitDirWatcher = await watcher.subscribe(
      gitDir.path,
      onEvents((filePath) => isGitDirPointerFile(gitDir.path, filePath)),
      { ignore: GIT_DIR_IGNORES },
    );
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
    await this.gitDirWatcher?.unsubscribe();
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
