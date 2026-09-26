import simpleGit from 'simple-git';
import { z } from 'zod';
import type { FileContents } from '../../../shared/changes-types';
import { detectLanguage } from '../../../shared/detect-language';
import { publicProcedure, router } from '../trpc';
import { gitCache } from './cache';
import { secureFs } from './security';

/** Maximum file size for reading (2 MiB) */
const MAX_FILE_SIZE = 2 * 1024 * 1024;

/** Bytes to scan for binary detection */
const BINARY_CHECK_SIZE = 8192;

/**
 * Detects if a buffer contains binary content by checking for NUL bytes
 */
function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

export const createFileContentsRouter = () => {
  return router({
    getFileContents: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          filePath: z.string(),
          oldPath: z.string().optional(),
          category: z.enum(['against-base', 'committed', 'staged', 'unstaged']),
          commitHash: z.string().optional(),
          defaultBranch: z.string().optional(),
        }),
      )
      .query(async ({ input }): Promise<FileContents> => {
        // Build cache key from all relevant parameters
        const cacheKey = `${input.filePath}:${input.category}:${input.commitHash || 'working'}:${input.oldPath || ''}`;

        // Check cache first
        const cached = gitCache.getFileContent(input.worktreePath, cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as FileContents;
            return parsed;
          } catch {
            // Invalid cache entry, continue to fetch
          }
        }
        const git = simpleGit(input.worktreePath);
        const defaultBranch = input.defaultBranch || 'main';
        const originalPath = input.oldPath || input.filePath;

        const { original, modified } = await getFileVersions(
          git,
          input.worktreePath,
          input.filePath,
          originalPath,
          input.category,
          defaultBranch,
          input.commitHash,
        );

        const result: FileContents = {
          original,
          modified,
          language: detectLanguage(input.filePath),
        };

        // Store in cache
        gitCache.setFileContent(input.worktreePath, cacheKey, JSON.stringify(result));

        return result;
      }),

    saveFile: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          filePath: z.string(),
          content: z.string(),
        }),
      )
      .mutation(async ({ input }): Promise<{ success: boolean }> => {
        await secureFs.writeFile(input.worktreePath, input.filePath, input.content);
        return { success: true };
      }),

    /**
     * Read multiple working tree files in a single IPC call.
     * Used for batch prefetching file contents for diff view.
     */
    readMultipleWorkingFiles: publicProcedure
      .input(
        z.object({
          worktreePath: z.string(),
          files: z.array(
            z.object({
              key: z.string(),
              filePath: z.string(),
            }),
          ),
        }),
      )
      .query(
        async ({
          input,
        }): Promise<Record<string, { ok: true; content: string } | { ok: false }>> => {
          const results: Record<string, { ok: true; content: string } | { ok: false }> = {};

          // Read all files in parallel within the same IPC call
          await Promise.all(
            input.files.map(async ({ key, filePath }) => {
              try {
                const stats = await secureFs.stat(input.worktreePath, filePath);
                if (stats.size > MAX_FILE_SIZE) {
                  results[key] = { ok: false };
                  return;
                }

                const buffer = await secureFs.readFileBuffer(input.worktreePath, filePath);

                if (isBinaryContent(buffer)) {
                  results[key] = { ok: false };
                  return;
                }

                results[key] = {
                  ok: true,
                  content: buffer.toString('utf-8'),
                };
              } catch {
                results[key] = { ok: false };
              }
            }),
          );

          return results;
        },
      ),
  });
};

type DiffCategory = 'against-base' | 'committed' | 'staged' | 'unstaged';

type FileVersions = {
  original: string;
  modified: string;
};

async function getFileVersions(
  git: ReturnType<typeof simpleGit>,
  worktreePath: string,
  filePath: string,
  originalPath: string,
  category: DiffCategory,
  defaultBranch: string,
  commitHash?: string,
): Promise<FileVersions> {
  switch (category) {
    case 'against-base':
      return getAgainstBaseVersions(git, filePath, originalPath, defaultBranch);

    case 'committed':
      if (!commitHash) {
        throw new Error('commitHash required for committed category');
      }
      return getCommittedVersions(git, filePath, originalPath, commitHash);

    case 'staged':
      return getStagedVersions(git, filePath, originalPath);

    case 'unstaged':
      return getUnstagedVersions(git, worktreePath, filePath, originalPath);
  }
}

/** Helper to safely get git show content with size limit and memory protection */
async function safeGitShow(git: ReturnType<typeof simpleGit>, spec: string): Promise<string> {
  try {
    // Preflight: check blob size before loading into memory
    // This prevents memory spikes from large files in git history
    try {
      const sizeOutput = await git.raw(['cat-file', '-s', spec]);
      const blobSize = Number.parseInt(sizeOutput.trim(), 10);
      if (!Number.isNaN(blobSize) && blobSize > MAX_FILE_SIZE) {
        return `[File content truncated - exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit]`;
      }
    } catch {
      // cat-file failed (blob doesn't exist) - let git.show handle the error
    }

    const content = await git.show([spec]);
    return content;
  } catch {
    return '';
  }
}

async function getAgainstBaseVersions(
  git: ReturnType<typeof simpleGit>,
  filePath: string,
  originalPath: string,
  defaultBranch: string,
): Promise<FileVersions> {
  const [original, modified] = await Promise.all([
    safeGitShow(git, `origin/${defaultBranch}:${originalPath}`),
    safeGitShow(git, `HEAD:${filePath}`),
  ]);

  return { original, modified };
}

async function getCommittedVersions(
  git: ReturnType<typeof simpleGit>,
  filePath: string,
  originalPath: string,
  commitHash: string,
): Promise<FileVersions> {
  const [original, modified] = await Promise.all([
    safeGitShow(git, `${commitHash}^:${originalPath}`),
    safeGitShow(git, `${commitHash}:${filePath}`),
  ]);

  return { original, modified };
}

async function getStagedVersions(
  git: ReturnType<typeof simpleGit>,
  filePath: string,
  originalPath: string,
): Promise<FileVersions> {
  const [original, modified] = await Promise.all([
    safeGitShow(git, `HEAD:${originalPath}`),
    safeGitShow(git, `:0:${filePath}`),
  ]);

  return { original, modified };
}

async function getUnstagedVersions(
  git: ReturnType<typeof simpleGit>,
  worktreePath: string,
  filePath: string,
  originalPath: string,
): Promise<FileVersions> {
  // Try staged version first, fall back to HEAD
  let original: string | null = await safeGitShow(git, `:0:${originalPath}`);
  if (!original) {
    original = await safeGitShow(git, `HEAD:${originalPath}`);
  }

  let modified: string = '';
  try {
    const stats = await secureFs.stat(worktreePath, filePath);
    if (stats.size <= MAX_FILE_SIZE) {
      modified = await secureFs.readFile(worktreePath, filePath);
    } else {
      modified = `[File content truncated - exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit]`;
    }
  } catch {
    // File doesn't exist or validation failed - that's ok for diff display
    modified = '';
  }

  return { original, modified };
}
