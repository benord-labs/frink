import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';
import simpleGit from 'simple-git';

const APPLY_RETRIES = 3;
const APPLY_RETRY_DELAY_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CheckpointPayload = {
  sdkMessageUuid: string;
  indexTree: string;
  worktreeTree: string;
};

/**
 * Create a checkpoint ref for rollback support.
 * Stores index and worktree trees in an orphan commit under refs/checkpoints/.
 * If there are no changes, no checkpoint is created (this is fine).
 */
/**
 * Per-cwd serialization queue. Two stashes against the same working tree race
 * on git's internal lockfiles (simple-git pre-flights `.git/index.lock`,
 * `packed-refs.lock`) and one will silently fail. Multi-pane sub-chats and
 * queued-message turns can both produce same-cwd concurrency, so we chain
 * stashes per cwd instead of running them in parallel.
 */
const stashQueueByCwd = new Map<string, Promise<void>>();

/** Tracks every in-flight stash promise so graceful shutdown can drain them. */
const inFlightStashes = new Set<Promise<void>>();

export async function createRollbackStash(cwd: string, sdkMessageUuid: string): Promise<void> {
  const prior = stashQueueByCwd.get(cwd) ?? Promise.resolve();
  const next = prior
    .catch(() => {
      // Upstream failures must not poison the queue — each stash is independent.
    })
    .then(() => createRollbackStashInner(cwd, sdkMessageUuid));
  stashQueueByCwd.set(cwd, next);
  inFlightStashes.add(next);
  void next.finally(() => {
    inFlightStashes.delete(next);
    // Only clear the queue head if no later stash chained on to this one.
    if (stashQueueByCwd.get(cwd) === next) {
      stashQueueByCwd.delete(cwd);
    }
  });
  return next;
}

/**
 * Wait for every in-flight rollback stash to settle. Bounded by `timeoutMs` so
 * a hung git process can't block app shutdown indefinitely. Returns even if a
 * stash rejects — that's already logged inside `createRollbackStashInner`.
 */
export async function drainInFlightRollbackStashes(timeoutMs = 3000): Promise<void> {
  if (inFlightStashes.size === 0) return;
  await Promise.race([
    Promise.allSettled([...inFlightStashes]),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
    }),
  ]);
}

async function createRollbackStashInner(cwd: string, sdkMessageUuid: string): Promise<void> {
  try {
    const git = simpleGit(cwd);

    // Skip non-git directories (e.g. general chats use homedir)
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return;

    const indexTreeRaw = await git.raw(['write-tree']);
    const indexTree = indexTreeRaw.trim();
    if (!indexTree) {
      return;
    }

    let worktreeTree: string = '';
    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-index-'));
      const tempIndexPath = join(tempDir, 'index');
      const gitWithTempIndex = simpleGit(cwd).env({
        GIT_INDEX_FILE: tempIndexPath,
      });
      await gitWithTempIndex.raw(['add', '-A']);
      worktreeTree = (await gitWithTempIndex.raw(['write-tree'])).trim();
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }

    if (!worktreeTree) {
      return;
    }

    const checkpointPayload: CheckpointPayload = {
      sdkMessageUuid,
      indexTree,
      worktreeTree,
    };
    const commitRaw = await git.raw([
      '-c',
      'user.name=Checkpoint',
      '-c',
      'user.email=checkpoint@local',
      'commit-tree',
      worktreeTree,
      '-m',
      JSON.stringify(checkpointPayload),
    ]);
    const commitHash = commitRaw.trim();
    if (!commitHash) {
      return;
    }

    await git.raw(['update-ref', `refs/checkpoints/${sdkMessageUuid}`, commitHash]);
    log.info(`[Rollback] Checkpoint created for ${sdkMessageUuid} in ${cwd}`);
  } catch (e) {
    log.error('[Rollback] Failed to create checkpoint', { cwd, sdkMessageUuid, error: e });
  }
}

function parseCheckpointTrees(message: string): {
  indexTree: string | null;
  worktreeTree: string | null;
} {
  const body = message.trim();
  if (body) {
    try {
      const parsed = JSON.parse(body) as CheckpointPayload;
      if (parsed.indexTree && parsed.worktreeTree) {
        return {
          indexTree: parsed.indexTree,
          worktreeTree: parsed.worktreeTree,
        };
      }
    } catch {
      // Ignore invalid payload.
    }
  }
  return {
    indexTree: null,
    worktreeTree: null,
  };
}

export type RollbackResult =
  | { success: true; checkpointFound: true }
  | { success: true; checkpointFound: false }
  | { success: false; error: string };

export async function applyRollbackStash(
  worktreePath: string,
  sdkMessageUuid: string,
): Promise<RollbackResult> {
  // Enroll on the same per-cwd queue as createRollbackStash. Apply runs
  // `read-tree` / `checkout-index` / `clean` against the main index, which
  // contends with createRollbackStash's `write-tree` and `update-ref` calls
  // on the same `.git/<lock>` files. Without joining the queue here, a create
  // stash kicked off AFTER this apply starts would bypass serialization and
  // race. We chain through `stashQueueByCwd` but deliberately do NOT enrol in
  // `inFlightStashes` — that set drives `drainInFlightRollbackStashes` which
  // is a shutdown helper for fire-and-forget creates only; an apply is always
  // awaited by a tRPC caller and shouldn't extend the shutdown grace window.
  const prior = stashQueueByCwd.get(worktreePath) ?? Promise.resolve();
  const result = prior
    .catch(() => {
      // Upstream stash failure is logged by createRollbackStashInner; the
      // apply proceeds regardless because the checkpoint we're applying is
      // older than (and so unaffected by) the failed stash.
    })
    .then(() => applyRollbackStashInner(worktreePath, sdkMessageUuid));
  // Queue carries a void Promise (matches createRollbackStash's shape). A swallowed
  // rejection here is fine — the actual RollbackResult is returned via `result`.
  const queueEntry: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  stashQueueByCwd.set(worktreePath, queueEntry);
  void queueEntry.finally(() => {
    if (stashQueueByCwd.get(worktreePath) === queueEntry) {
      stashQueueByCwd.delete(worktreePath);
    }
  });
  return result;
}

async function applyRollbackStashInner(
  worktreePath: string,
  sdkMessageUuid: string,
): Promise<RollbackResult> {
  try {
    const git = simpleGit(worktreePath);

    const ref = `refs/checkpoints/${sdkMessageUuid}`;
    let commitHash: string = '';
    try {
      commitHash = (await git.raw(['rev-parse', ref])).trim();
    } catch (_error) {
      // Checkpoint not found; caller decides whether to proceed.
      return { success: true, checkpointFound: false };
    }

    const commitMessage = await git.raw(['show', '-s', '--format=%B', commitHash]);
    const { indexTree, worktreeTree } = parseCheckpointTrees(commitMessage);
    if (!indexTree || !worktreeTree) {
      return { success: false, error: 'Checkpoint missing tree metadata' };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= APPLY_RETRIES; attempt += 1) {
      try {
        await git.raw(['read-tree', worktreeTree]);
        await git.raw(['checkout-index', '-a', '-f']);
        await git.raw(['clean', '-fd']);
        await git.raw(['read-tree', indexTree]);
        return { success: true, checkpointFound: true };
      } catch (error) {
        lastError = error;
        if (attempt < APPLY_RETRIES) {
          await sleep(APPLY_RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}
