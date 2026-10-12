import { stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import simpleGit, { type StatusResult } from 'simple-git';
import { getDefaultBranch, refExistsLocally } from '../worktree';

type WorktreeDiffResult = { success: boolean; diff?: string; error?: string };
type WorktreeDiffOptions = { onlyUncommitted?: boolean };

/** The git calls a worktree diff makes. */
export type WorktreeDiffGit = {
  status(): Promise<StatusResult>;
  diff(args: string[]): Promise<string>;
  raw(args: string[]): Promise<string>;
};

/** Untracked files above this are listed as binary instead of diffed: a multi-hundred-MB file
 * makes each `git diff --no-index` run for minutes, and every refresh starts another. */
const MAX_UNTRACKED_DIFF_SIZE = 1024 * 1024;

/** Each diffed untracked file costs one git process, so only the most recently modified ones
 * are diffed and the rest are listed as binary. */
export const MAX_UNTRACKED_DIFFED_FILES = 100;

const LOCKFILE_EXCLUSIONS = [
  ':!*.lock',
  ':!*-lock.*',
  ':!package-lock.json',
  ':!pnpm-lock.yaml',
  ':!yarn.lock',
];

const isLockfile = (file: string) => file.endsWith('.lock') || file.includes('-lock.');

const listedOnlyStanza = (file: string) =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ`;

/** The untracked files worth a real diff: under the size cap, newest first, up to the file cap. */
function pickFilesToDiff(sized: { file: string; size: number; mtimeMs: number }[]): Set<string> {
  const newestFirst = sized
    .filter((entry) => entry.size <= MAX_UNTRACKED_DIFF_SIZE)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return new Set(newestFirst.slice(0, MAX_UNTRACKED_DIFFED_FILES).map((entry) => entry.file));
}

async function diffUntrackedFile(git: WorktreeDiffGit, file: string): Promise<string | null> {
  try {
    return (await git.raw(['diff', '--no-color', '--no-index', devNull, file])) || null;
  } catch (error: unknown) {
    // git diff --no-index exits 1 when files differ; simple-git throws with the diff in the message
    const message = error instanceof Error ? error.message : undefined;
    const diffStart = message?.indexOf('diff --git') ?? -1;
    return message && diffStart !== -1 ? message.substring(diffStart) : null;
  }
}

async function diffUntrackedFiles(
  git: WorktreeDiffGit,
  worktreePath: string,
  files: string[],
): Promise<string> {
  const sized: { file: string; size: number; mtimeMs: number }[] = [];
  for (const file of files) {
    try {
      const { size, mtimeMs } = await stat(join(worktreePath, file));
      sized.push({ file, size, mtimeMs });
    } catch {
      // Gone since `git status` listed it: nothing to show.
    }
  }

  const toDiff = pickFilesToDiff(sized);
  const stanzas: string[] = [];
  for (const { file } of sized) {
    // git diff --no-index only accepts 2 paths, so each file is diffed separately
    const stanza = toDiff.has(file) ? await diffUntrackedFile(git, file) : listedOnlyStanza(file);
    if (stanza) stanzas.push(stanza);
  }
  return stanzas.join('\n');
}

async function runWorktreeDiff(
  openGit: (worktreePath: string) => WorktreeDiffGit,
  worktreePath: string,
  baseBranch: string | undefined,
  options: WorktreeDiffOptions | undefined,
  onStart: () => void,
): Promise<WorktreeDiffResult> {
  // Git has not read the worktree yet, so calls made in this same tick can safely share the run.
  await new Promise<void>((resolve) => setImmediate(resolve));
  onStart();
  try {
    const git = openGit(worktreePath);
    const status = await git.status();

    // Has uncommitted changes - diff against HEAD
    if (!status.isClean()) {
      const workingDiff = await git.diff(['HEAD', '--no-color', '--', ...LOCKFILE_EXCLUSIONS]);
      const untrackedDiff = await diffUntrackedFiles(
        git,
        worktreePath,
        status.not_added.filter((file) => !isLockfile(file)),
      );
      return { success: true, diff: [workingDiff, untrackedDiff].filter(Boolean).join('\n') };
    }

    // All committed - if onlyUncommitted mode, return empty diff
    if (options?.onlyUncommitted) {
      return { success: true, diff: '' };
    }

    // All committed - diff against base branch
    const targetBranch = baseBranch || (await getDefaultBranch(worktreePath));
    const baseRef = (await refExistsLocally(worktreePath, `origin/${targetBranch}`))
      ? `origin/${targetBranch}`
      : targetBranch;

    try {
      const diff = await git.diff([
        `${baseRef}...HEAD`,
        '--no-color',
        '--',
        ...LOCKFILE_EXCLUSIONS,
      ]);
      return { success: true, diff: diff || '' };
    } catch {
      return { success: true, diff: '' };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

type InFlightDiff = {
  promise: Promise<WorktreeDiffResult>;
  /** True once git may have read the worktree: later callers may be reacting to a newer change. */
  started: boolean;
  trailing?: Promise<WorktreeDiffResult>;
};

/**
 * Builds a worktree differ with its own in-flight bookkeeping. Overlapping calls for the same
 * worktree share one run; callers that arrive once git is reading the worktree share a single rerun.
 */
export function createWorktreeDiff(
  openGit: (worktreePath: string) => WorktreeDiffGit = (worktreePath) => simpleGit(worktreePath),
) {
  const inFlightDiffs = new Map<string, InFlightDiff>();

  return function getWorktreeDiff(
    worktreePath: string,
    baseBranch?: string,
    options?: WorktreeDiffOptions,
  ): Promise<WorktreeDiffResult> {
    const key = JSON.stringify([worktreePath, baseBranch ?? null, !!options?.onlyUncommitted]);
    const running = inFlightDiffs.get(key);
    if (running) {
      if (!running.started) return running.promise;
      running.trailing ??= running.promise.then(() =>
        getWorktreeDiff(worktreePath, baseBranch, options),
      );
      return running.trailing;
    }

    const entry: InFlightDiff = {
      started: false,
      promise: runWorktreeDiff(openGit, worktreePath, baseBranch, options, () => {
        entry.started = true;
      }).finally(() => inFlightDiffs.delete(key)),
    };
    inFlightDiffs.set(key, entry);
    return entry.promise;
  };
}

/** Diff of a worktree: its uncommitted changes if any, else its branch against the base. */
export const getWorktreeDiff = createWorktreeDiff();
