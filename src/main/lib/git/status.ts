/* eslint-disable max-lines, max-lines-per-function */
import * as path from 'node:path';
import simpleGit from 'simple-git';
import { z } from 'zod';
import type {
  ChangedFile,
  GitChangesStatus,
  WorkingFileLineChangeRange,
  WorkingFileLineChangesResponse,
} from '../../../shared/changes-types';
import { publicProcedure, router } from '../trpc';
import { gitCache } from './cache';
import { secureFs } from './security';
import { gitLogArgs } from './commit-log';
import { applyNumstatToFiles } from './utils/apply-numstat';
import { GIT_LOG_FORMAT, parseGitLog, parseGitStatus, parseNameStatus } from './utils/parse-status';

// Regex constants
const WHITESPACE_REGEX = /\s+/;
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const LEADING_CURRENT_DIR_PREFIX_REGEX = /^\.([/\\])+/;
const MAX_LINE_MARKER_FILE_SIZE = 2 * 1024 * 1024;
const BINARY_CHECK_BYTES = 8192;
// Accept short/full SHAs and HEAD references: HEAD, HEAD~N, HEAD^, HEAD^^, HEAD^N.
const COMMIT_HASH_OR_HEAD_REF_REGEX = /^(?:[0-9a-fA-F]{7,40}|HEAD(?:(?:~\d+)|(?:\^+\d*))?)$/;
const KNOWN_NON_GIT_OR_INACCESSIBLE_ERROR_MESSAGES = [
  'not a git repository',
  'does not appear to be a git repository',
  'no such file or directory',
  'permission denied',
  'could not read from repository',
];

function isKnownNonGitOrInaccessibleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const maybeError = err as { code?: unknown; message?: unknown };
  if (maybeError.code === 'ENOENT' || maybeError.code === 'EACCES' || maybeError.code === 'EPERM') {
    return true;
  }

  if (typeof maybeError.message !== 'string') {
    return false;
  }

  const message = maybeError.message.toLowerCase();
  return KNOWN_NON_GIT_OR_INACCESSIBLE_ERROR_MESSAGES.some((indicator) =>
    message.includes(indicator),
  );
}

type ParsedHunkHeader = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

function parseHunkHeader(header: string): ParsedHunkHeader | null {
  const match = header.match(HUNK_HEADER_REGEX);
  if (!match) return null;

  const oldStart = Number.parseInt(match[1] || '0', 10);
  const oldCount = Number.parseInt(match[2] || '1', 10);
  const newStart = Number.parseInt(match[3] || '0', 10);
  const newCount = Number.parseInt(match[4] || '1', 10);

  return { oldStart, oldCount, newStart, newCount };
}

function normalizeFilePathForWorktree(worktreePath: string, filePath: string): string {
  const normalizedInput = path.normalize(filePath);
  const normalizedWorktree = path.resolve(worktreePath);

  if (path.isAbsolute(normalizedInput)) {
    const relative = path.relative(normalizedWorktree, normalizedInput);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('File path must be within worktree');
    }
    return relative.split(path.sep).join('/');
  }

  if (normalizedInput === '..' || normalizedInput.startsWith(`..${path.sep}`)) {
    throw new Error('File path must be within worktree');
  }

  return normalizedInput.replace(LEADING_CURRENT_DIR_PREFIX_REGEX, '').split(path.sep).join('/');
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

async function getWorkingFileLineCount(
  worktreePath: string,
  filePath: string,
): Promise<{ lineCount: number; unsupported: boolean }> {
  try {
    const stats = await secureFs.stat(worktreePath, filePath);
    if (stats.size > MAX_LINE_MARKER_FILE_SIZE) {
      return { lineCount: 0, unsupported: true };
    }

    const buffer = await secureFs.readFileBuffer(worktreePath, filePath);
    if (isBinaryBuffer(buffer)) {
      return { lineCount: 0, unsupported: true };
    }

    const content = buffer.toString('utf-8');
    if (content.length === 0) {
      return { lineCount: 0, unsupported: false };
    }

    return { lineCount: content.split('\n').length, unsupported: false };
  } catch {
    return { lineCount: 0, unsupported: false };
  }
}

async function isTrackedFile(
  git: ReturnType<typeof simpleGit>,
  normalizedFilePath: string,
): Promise<boolean> {
  try {
    await git.raw(['ls-files', '--error-unmatch', '--', normalizedFilePath]);
    return true;
  } catch {
    return false;
  }
}

function assertValidCommitHashOrRef(commitHash: string): void {
  if (!COMMIT_HASH_OR_HEAD_REF_REGEX.test(commitHash)) {
    throw new Error('Invalid commit hash format');
  }
}

function classifyRunToRanges(
  removedCount: number,
  addedCount: number,
  runStartNewLine: number,
): WorkingFileLineChangeRange[] {
  const ranges: WorkingFileLineChangeRange[] = [];
  const sharedCount = Math.min(removedCount, addedCount);

  if (sharedCount > 0) {
    ranges.push({
      type: 'modified',
      startLine: runStartNewLine,
      endLine: runStartNewLine + sharedCount - 1,
    });
  }

  if (addedCount > sharedCount) {
    const addedStart = runStartNewLine + sharedCount;
    ranges.push({
      type: 'added',
      startLine: addedStart,
      endLine: addedStart + (addedCount - sharedCount) - 1,
    });
  }

  if (removedCount > sharedCount) {
    const deletionAnchor = Math.max(1, runStartNewLine + sharedCount);
    ranges.push({
      type: 'deleted',
      startLine: deletionAnchor,
      endLine: deletionAnchor,
    });
  }

  return ranges;
}

function pushClassifiedRunRanges(
  ranges: WorkingFileLineChangeRange[],
  removedCount: number,
  addedCount: number,
  runStartNewLine: number,
): void {
  const classifiedRanges = classifyRunToRanges(removedCount, addedCount, runStartNewLine);
  ranges.push(...classifiedRanges);
}

export function extractWorkingFileLineChangesFromDiff(
  diffText: string,
): WorkingFileLineChangeRange[] {
  if (!diffText.trim()) {
    return [];
  }

  const ranges: WorkingFileLineChangeRange[] = [];
  const lines = diffText.replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || '';
    if (!line.startsWith('@@')) {
      i += 1;
      continue;
    }

    const hunk = parseHunkHeader(line);
    if (!hunk) {
      i += 1;
      continue;
    }

    let newLine = hunk.newStart;
    i += 1;

    while (i < lines.length) {
      const bodyLine = lines[i] || '';
      if (bodyLine.startsWith('@@') || bodyLine.startsWith('diff --git ')) {
        break;
      }

      if (bodyLine.startsWith(' ')) {
        newLine += 1;
        i += 1;
        continue;
      }

      // Parse contiguous add/remove run so we can classify added/deleted/modified
      // more precisely than hunk-level headers.
      if (bodyLine.startsWith('-') || bodyLine.startsWith('+')) {
        const runStartNewLine = newLine;
        let removedCount = 0;
        let addedCount = 0;

        while (i < lines.length) {
          const runLine = lines[i] || '';
          if (runLine.startsWith('-')) {
            removedCount += 1;
            i += 1;
            continue;
          }
          if (runLine.startsWith('+')) {
            addedCount += 1;
            newLine += 1;
            i += 1;
            continue;
          }
          break;
        }

        pushClassifiedRunRanges(ranges, removedCount, addedCount, runStartNewLine);
        continue;
      }

      i += 1;
    }
  }

  // De-dupe identical ranges as a defensive guard against repeated input segments.
  const deduped = new Map<string, WorkingFileLineChangeRange>();
  for (const range of ranges) {
    deduped.set(`${range.type}:${range.startLine}:${range.endLine}`, range);
  }
  return Array.from(deduped.values());
}

export const createStatusRouter = () => {
  return router({
    getStatus: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          defaultBranch: z.string().optional(),
        }),
      )
      .query(async ({ input }): Promise<GitChangesStatus> => {
        // Check cache first
        const cached = gitCache.getStatus<GitChangesStatus>(input.worktreePath);
        if (cached) {
          return cached;
        }
        const git = simpleGit(input.worktreePath);
        const defaultBranch = input.defaultBranch || 'main';

        const status = await git.status();
        const parsed = parseGitStatus(status);

        // Run independent git operations in parallel (VS Code style)
        const [branchComparison, trackingStatus] = await Promise.all([
          getBranchComparison(git, defaultBranch),
          getTrackingBranchStatus(git),
        ]);

        // Run numstat operations in parallel
        await Promise.all([
          applyNumstatToFiles(git, parsed.staged, ['diff', '--cached', '--numstat']),
          applyNumstatToFiles(git, parsed.unstaged, ['diff', '--numstat']),
          applyUntrackedLineCount(input.worktreePath, parsed.untracked),
        ]);

        const result: GitChangesStatus = {
          branch: parsed.branch,
          defaultBranch,
          againstBase: branchComparison.againstBase,
          commits: branchComparison.commits,
          staged: parsed.staged,
          unstaged: parsed.unstaged,
          untracked: parsed.untracked,
          ahead: branchComparison.ahead,
          behind: branchComparison.behind,
          pushCount: trackingStatus.pushCount,
          pullCount: trackingStatus.pullCount,
          hasUpstream: trackingStatus.hasUpstream,
        };

        // Store in cache
        gitCache.setStatus(input.worktreePath, result);
        return result;
      }),
    getWorkingFileLineChanges: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          filePath: z.string(),
        }),
      )
      .query(async ({ input }): Promise<WorkingFileLineChangesResponse> => {
        try {
          const normalizedFilePath = normalizeFilePathForWorktree(
            input.worktreePath,
            input.filePath,
          );
          const git = simpleGit(input.worktreePath);
          const tracked = await isTrackedFile(git, normalizedFilePath);

          if (!tracked) {
            const { lineCount, unsupported } = await getWorkingFileLineCount(
              input.worktreePath,
              normalizedFilePath,
            );
            if (unsupported) {
              return { ranges: [], unsupported: true };
            }
            if (lineCount === 0) {
              return { ranges: [], unsupported: false };
            }
            return {
              ranges: [{ type: 'added', startLine: 1, endLine: lineCount }],
              unsupported: false,
            };
          }

          const diffText = await git.raw([
            'diff',
            '--no-color',
            '--no-ext-diff',
            '-U0',
            'HEAD',
            '--',
            normalizedFilePath,
          ]);

          if (diffText.includes('Binary files') && diffText.includes('differ')) {
            return { ranges: [], unsupported: true };
          }

          const parsedRanges = extractWorkingFileLineChangesFromDiff(diffText);
          return {
            ranges: parsedRanges,
            unsupported: false,
          };
        } catch (err) {
          if (isKnownNonGitOrInaccessibleError(err)) {
            return { ranges: [], unsupported: true };
          }
          throw err;
        }
      }),

    getCommitFiles: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          commitHash: z.string(),
        }),
      )
      .query(async ({ input }): Promise<ChangedFile[]> => {
        assertValidCommitHashOrRef(input.commitHash);

        const git = simpleGit(input.worktreePath);

        const nameStatus = await git.raw([
          'diff-tree',
          '--no-commit-id',
          '--name-status',
          '-r',
          input.commitHash,
        ]);

        const files = parseNameStatus(nameStatus);

        await applyNumstatToFiles(git, files, [
          'diff-tree',
          '--no-commit-id',
          '--numstat',
          '-r',
          input.commitHash,
        ]);
        return files;
      }),

    getOriginalContent: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          filePath: z.string(),
        }),
      )
      .query(async ({ input }): Promise<{ content: string | null }> => {
        try {
          const normalizedFilePath = normalizeFilePathForWorktree(
            input.worktreePath,
            input.filePath,
          );
          const git = simpleGit(input.worktreePath);
          const tracked = await isTrackedFile(git, normalizedFilePath);
          if (!tracked) {
            return { content: '' };
          }
          const content = await git.show([`HEAD:${normalizedFilePath}`]);
          return { content };
        } catch {
          return { content: null };
        }
      }),

    /** Get the unified diff for a specific file in a commit */
    getCommitFileDiff: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          commitHash: z.string(),
          filePath: z.string(),
        }),
      )
      .query(async ({ input }): Promise<string> => {
        assertValidCommitHashOrRef(input.commitHash);
        const normalizedFilePath = normalizeFilePathForWorktree(input.worktreePath, input.filePath);

        const git = simpleGit(input.worktreePath);

        // Get diff for specific file comparing commit to its parent
        const diff = await git.raw([
          'diff',
          `${input.commitHash}^`,
          input.commitHash,
          '--',
          normalizedFilePath,
        ]);

        return diff;
      }),
  });
};

type BranchComparison = {
  commits: GitChangesStatus['commits'];
  againstBase: ChangedFile[];
  ahead: number;
  behind: number;
};

async function getBranchComparison(
  git: ReturnType<typeof simpleGit>,
  defaultBranch: string,
): Promise<BranchComparison> {
  let commits: GitChangesStatus['commits'] = [];
  let againstBase: ChangedFile[] = [];
  let ahead: number = 0;
  let behind: number = 0;

  try {
    const tracking = await git.raw([
      'rev-list',
      '--left-right',
      '--count',
      `origin/${defaultBranch}...HEAD`,
    ]);
    const [behindStr, aheadStr] = tracking.trim().split(WHITESPACE_REGEX);
    behind = Number.parseInt(behindStr || '0', 10);
    ahead = Number.parseInt(aheadStr || '0', 10);

    const logOutput = await git.raw(gitLogArgs(GIT_LOG_FORMAT, `origin/${defaultBranch}..HEAD`));
    commits = parseGitLog(logOutput);

    if (ahead > 0) {
      const nameStatus = await git.raw(['diff', '--name-status', `origin/${defaultBranch}...HEAD`]);
      againstBase = parseNameStatus(nameStatus);

      await applyNumstatToFiles(git, againstBase, [
        'diff',
        '--numstat',
        `origin/${defaultBranch}...HEAD`,
      ]);
    }
  } catch {}

  return { commits, againstBase, ahead, behind };
}

/** Max file size for line counting (1 MiB) - skip larger files to avoid OOM */
const MAX_LINE_COUNT_SIZE = 1 * 1024 * 1024;

async function applyUntrackedLineCount(
  worktreePath: string,
  untracked: ChangedFile[],
): Promise<void> {
  for (const file of untracked) {
    try {
      const stats = await secureFs.stat(worktreePath, file.path);
      if (stats.size > MAX_LINE_COUNT_SIZE) continue;

      const content = await secureFs.readFile(worktreePath, file.path);
      const lineCount = content.split('\n').length;
      file.additions = lineCount;
      file.deletions = 0;
    } catch {
      // Skip files that fail validation or reading
    }
  }
}

type TrackingStatus = {
  pushCount: number;
  pullCount: number;
  hasUpstream: boolean;
};

async function getTrackingBranchStatus(git: ReturnType<typeof simpleGit>): Promise<TrackingStatus> {
  try {
    // Single git call - rev-list will fail if no upstream exists
    // This is faster than checking upstream first, then counting
    const tracking = await git.raw(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    const [pullStr, pushStr] = tracking.trim().split(WHITESPACE_REGEX);
    return {
      pushCount: Number.parseInt(pushStr || '0', 10),
      pullCount: Number.parseInt(pullStr || '0', 10),
      hasUpstream: true,
    };
  } catch {
    // No upstream branch configured
    return { pushCount: 0, pullCount: 0, hasUpstream: false };
  }
}
