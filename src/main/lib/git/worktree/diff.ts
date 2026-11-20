import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import simpleGit, { type StatusResult } from 'simple-git';
import { getDefaultBranch, refExistsLocally } from '../worktree';

type WorktreeDiffResult = { success: boolean; diff?: string; error?: string };
type WorktreeDiffOptions = { onlyUncommitted?: boolean };

/** The git calls a worktree diff makes. */
export type WorktreeDiffGit = {
  status(): Promise<StatusResult>;
  diff(args: string[]): Promise<string>;
};

/** Untracked files above this are listed as binary instead of read into the diff text. */
const MAX_UNTRACKED_DIFF_SIZE = 1024 * 1024;

/** Bounds the diff text sent to the renderer: only the newest untracked files are shown in full,
 * the rest are listed as binary. */
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

/** `other` is anything that cannot be read as text: a nested repository's directory, a pipe, a device. */
type SizedFile = {
  file: string;
  size: number;
  mtimeMs: number;
  mode: number;
  kind: 'file' | 'link' | 'other';
};

/** The untracked files worth a real diff: under the size cap, newest first, up to the file cap. */
function pickFilesToDiff(sized: SizedFile[]): Set<string> {
  const newestFirst = sized
    .filter((entry) => entry.kind !== 'other' && entry.size <= MAX_UNTRACKED_DIFF_SIZE)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return new Set(newestFirst.slice(0, MAX_UNTRACKED_DIFFED_FILES).map((entry) => entry.file));
}

/** The stanza `git diff --no-index /dev/null <file>` prints, minus its unread `index` line. A
 * symlink is shown as git shows it, by its target path, and is never followed. */
async function newFileStanza(worktreePath: string, entry: SizedFile): Promise<string> {
  const { file } = entry;
  const path = join(worktreePath, file);
  const isLink = entry.kind === 'link';
  const buf = isLink ? Buffer.from(await readlink(path)) : await readFile(path);
  const fileMode = isLink ? '120000' : entry.mode & 0o100 ? '100755' : '100644';
  const header = `diff --git a/${file} b/${file}\nnew file mode ${fileMode}`;
  if (buf.length === 0) return header;
  // git's own binary heuristic: a NUL byte in the first 8000 bytes
  if (buf.subarray(0, 8000).includes(0)) {
    return `${header}\nBinary files /dev/null and b/${file} differ`;
  }
  const lines = buf.toString('utf8').split('\n');
  const endsWithNewline = lines.at(-1) === '';
  if (endsWithNewline) lines.pop();
  const range = lines.length === 1 ? '1' : `1,${lines.length}`;
  return [
    header,
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +${range} @@`,
    ...lines.map((line) => `+${line}`),
    ...(endsWithNewline ? [] : ['\\ No newline at end of file']),
  ].join('\n');
}

async function diffUntrackedFiles(worktreePath: string, files: string[]): Promise<string> {
  const sized: SizedFile[] = [];
  for (const file of files) {
    try {
      // lstat, so a symlink is measured and shown as itself, never as the file it points at
      const stats = await lstat(join(worktreePath, file));
      const kind = stats.isSymbolicLink() ? 'link' : stats.isFile() ? 'file' : 'other';
      sized.push({ file, size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode, kind });
    } catch {
      // Gone since `git status` listed it: nothing to show.
    }
  }

  const toDiff = pickFilesToDiff(sized);
  const stanzas: string[] = [];
  for (const entry of sized) {
    // Gone since the stat: nothing to show
    const stanza = toDiff.has(entry.file)
      ? await newFileStanza(worktreePath, entry).catch(() => null)
      : listedOnlyStanza(entry.file);
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
