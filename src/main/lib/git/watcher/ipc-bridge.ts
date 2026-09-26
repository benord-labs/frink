import * as path from 'node:path';
import { type BrowserWindow, ipcMain } from 'electron';
import { invalidateFileListCache, invalidateGitStatusCache } from '../../trpc/routers/files';
import { gitCache } from '../cache';
import { isGitPointerRelatedPath } from './git-head-path';
import { type GitWatchEvent, gitWatcherRegistry } from './git-watcher';

/** IDE config directories that trigger discovery notifications.
 *  Note: .cursor/mcp.json is excluded — MCP has its own auto-import pipeline (`runMcpImporter`). */
const IDE_CONFIG_PATTERNS = [
  '.cursor/agents/',
  '.cursor/skills/',
  '.cursor/commands/',
  '.cursor/hooks/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/commands/',
  '.claude/hooks/',
];

const BACKSLASH_RE = /\\/g;
const TRAILING_SLASH_RE = /\/$/;

/** Check if a file change is in an IDE config directory */
function getIdeConfigChanges(
  changes: Array<{ path: string; type: string }>,
  worktreePath: string,
): Array<{ path: string; type: string; resourceType: string; origin: string }> {
  const results: Array<{ path: string; type: string; resourceType: string; origin: string }> = [];
  for (const change of changes) {
    // Get relative path from worktree
    const relPath = path.relative(worktreePath, change.path).replace(BACKSLASH_RE, '/');
    for (const pattern of IDE_CONFIG_PATTERNS) {
      if (relPath.startsWith(pattern) || relPath === pattern.replace(TRAILING_SLASH_RE, '')) {
        const parts = pattern.split('/');
        const origin = parts[0].replace('.', ''); // 'cursor' or 'claude'
        const resourceType = parts[1]; // 'agents', 'skills', 'commands', or 'hooks'
        results.push({ path: change.path, type: change.type, resourceType, origin });
        break;
      }
    }
  }
  return results;
}

function hasGitPointerChange(changes: Array<{ path: string; type: string }>): boolean {
  return changes.some((change) => isGitPointerRelatedPath(change.path));
}

/**
 * IPC Bridge for GitWatcher.
 * Handles subscription/unsubscription from renderer and forwards file change events.
 */

// Track active subscriptions per worktree with ref counting for multi-pane same-project usage.
// `ready` is recorded before the watcher starts, so overlapping subscribes share one watcher.
type WatcherSubscription = { ready: Promise<() => void>; count: number };
const activeSubscriptions: Map<string, WatcherSubscription> = new Map();

/** Stops a subscription's watcher once it has started; one that failed to start has none. */
async function stopWatcher(subscription: WatcherSubscription): Promise<void> {
  await subscription.ready.then(
    (stop) => stop(),
    () => undefined,
  );
}

// Throttle events per worktree to prevent infinite loops
const lastEventTime: Map<string, number> = new Map();
const pendingEventByWorktree: Map<string, GitWatchEvent> = new Map();
const pendingEventTimerByWorktree: Map<string, NodeJS.Timeout> = new Map();
const EVENT_THROTTLE_MS = 500; // Minimum 500ms between events to renderer

/**
 * Register IPC handlers for git watcher.
 * Call this once during app initialization.
 */
export function registerGitWatcherIPC(getWindow: () => BrowserWindow | null): void {
  const forwardStatusChangeToRenderer = (
    event: GitWatchEvent,
    containsGitPointerChange: boolean,
  ): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;

    const worktreePath = event.worktreePath;
    gitCache.invalidateStatus(worktreePath);
    gitCache.invalidateParsedDiff(worktreePath);
    if (containsGitPointerChange) {
      gitCache.invalidateAllFileContents(worktreePath);
    } else {
      for (const change of event.changes) {
        if (isGitPointerRelatedPath(change.path)) continue;
        const relativePath = path.relative(worktreePath, change.path).replace(BACKSLASH_RE, '/');
        if (!relativePath || relativePath.startsWith('..')) continue;
        gitCache.invalidateFileContentsByPath(worktreePath, relativePath);
      }
    }
    invalidateGitStatusCache(worktreePath);
    invalidateFileListCache(worktreePath);

    win.webContents.send('git:status-changed', {
      worktreePath: event.worktreePath,
      changes: event.changes,
    });
  };

  const clearPendingEventForWorktree = (worktreePath: string): void => {
    const timer = pendingEventTimerByWorktree.get(worktreePath);
    if (timer) {
      clearTimeout(timer);
      pendingEventTimerByWorktree.delete(worktreePath);
    }
    pendingEventByWorktree.delete(worktreePath);
  };

  // Handle subscription requests from renderer
  ipcMain.handle('git:subscribe-watcher', async (_event, worktreePath: string) => {
    if (!worktreePath) return;

    const existing = activeSubscriptions.get(worktreePath);
    if (existing) {
      existing.count += 1;
      await existing.ready;
      return;
    }

    // Subscribe to git file changes (.git/index and .git/HEAD)
    const ready = gitWatcherRegistry.subscribe(worktreePath, (event: GitWatchEvent) => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;

      // Always check IDE config changes first (rare, significant events — not throttled)
      const ideChanges = getIdeConfigChanges(event.changes, event.worktreePath);
      if (ideChanges.length > 0) {
        // Deduplicate by resource type + origin, preserving type (prefer non-unlink over unlink)
        const uniqueChanges = new Map<
          string,
          { resourceType: string; origin: string; type: string }
        >();
        for (const change of ideChanges) {
          const key = `${change.origin}:${change.resourceType}`;
          const existing = uniqueChanges.get(key);
          // Keep add/change over unlink so the renderer knows something was added
          if (!existing || existing.type === 'unlink') {
            uniqueChanges.set(key, {
              resourceType: change.resourceType,
              origin: change.origin,
              type: change.type,
            });
          }
        }

        win.webContents.send('ide-config:changed', {
          worktreePath: event.worktreePath,
          changes: Array.from(uniqueChanges.values()),
        });
      }

      const containsGitPointerChange = hasGitPointerChange(event.changes);
      const eventWorktreePath = event.worktreePath;

      // Throttle git status events to prevent rapid fire.
      // Git pointer/index changes bypass throttling so external git ops are never dropped.
      // For non-pointer bursts, coalesce into one trailing event so we never lose final state.
      const now = Date.now();
      const lastTime = lastEventTime.get(eventWorktreePath) || 0;
      if (!containsGitPointerChange && now - lastTime < EVENT_THROTTLE_MS) {
        pendingEventByWorktree.set(eventWorktreePath, event);
        if (!pendingEventTimerByWorktree.has(eventWorktreePath)) {
          const delay = EVENT_THROTTLE_MS - (now - lastTime);
          const timer = setTimeout(() => {
            pendingEventTimerByWorktree.delete(eventWorktreePath);
            const pendingEvent = pendingEventByWorktree.get(eventWorktreePath);
            if (!pendingEvent) return;
            pendingEventByWorktree.delete(eventWorktreePath);
            lastEventTime.set(eventWorktreePath, Date.now());
            forwardStatusChangeToRenderer(pendingEvent, hasGitPointerChange(pendingEvent.changes));
          }, delay);
          pendingEventTimerByWorktree.set(eventWorktreePath, timer);
        }
        return;
      }
      if (containsGitPointerChange) {
        clearPendingEventForWorktree(eventWorktreePath);
      }
      lastEventTime.set(eventWorktreePath, now);
      forwardStatusChangeToRenderer(event, containsGitPointerChange);
    });

    const subscription: WatcherSubscription = { ready, count: 1 };
    activeSubscriptions.set(worktreePath, subscription);
    try {
      await ready;
    } catch (error) {
      // A watcher that failed to start must not be shared by the next subscribe
      if (activeSubscriptions.get(worktreePath) === subscription) {
        activeSubscriptions.delete(worktreePath);
      }
      throw error;
    }
  });

  // Handle unsubscription requests from renderer
  ipcMain.handle('git:unsubscribe-watcher', async (_event, worktreePath: string) => {
    if (!worktreePath) return;

    const existing = activeSubscriptions.get(worktreePath);
    if (existing) {
      existing.count -= 1;
      if (existing.count <= 0) {
        activeSubscriptions.delete(worktreePath);
        lastEventTime.delete(worktreePath);
        clearPendingEventForWorktree(worktreePath);
        await stopWatcher(existing);
      }
    }
  });
}

/**
 * Cleanup all watchers.
 * Call this when the app is shutting down.
 */
export async function cleanupGitWatchers(): Promise<void> {
  // Unsubscribe all
  const subscriptions = Array.from(activeSubscriptions.values());
  activeSubscriptions.clear();
  await Promise.all(subscriptions.map(stopWatcher));
  lastEventTime.clear();
  for (const timer of pendingEventTimerByWorktree.values()) {
    clearTimeout(timer);
  }
  pendingEventTimerByWorktree.clear();
  pendingEventByWorktree.clear();

  // Dispose all watchers
  await gitWatcherRegistry.disposeAll();
}
