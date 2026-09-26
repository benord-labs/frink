/* eslint-disable max-lines */
import { existsSync } from 'node:fs';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import simpleGit from 'simple-git';
import { z } from 'zod';
import type { FileStatus } from '../../../../shared/changes-types';
import { getImageMimeType, isImagePath } from '../../../../shared/image-extensions';
import { isPdfPath, MAX_PDF_BYTES } from '../../../../shared/pdf-extensions';
import { escapeRegExp } from '../../../../shared/utils/escape-regexp';
import { PathValidationError, resolvePathInWorktree } from '../../git/security/path-validation';
import { parseGitStatus } from '../../git/utils/parse-status';
import { captureMainException } from '../../sentry/init';
// NOTE: publicProcedure is appropriate here — this is Electron IPC (renderer→main),
// not a web API. The user's own machine is the trust boundary: these procedures
// reach any path the user could already open in a terminal. Operations that take a
// project path plus a relative path still enforce containment within that project.
import { publicProcedure, router } from '../index';

// Active copy operations — allows cancellation by operationId
type ActiveOperation = {
  controller: AbortController;
  ownerWebContentsId: number | undefined;
  timestamp: number;
};
const activeOperations = new Map<string, ActiveOperation>();
const OPERATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

const LINE_ENDING_REGEX = /\r?\n/;

// Periodic cleanup of stale operations
setInterval(() => {
  const now = Date.now();
  for (const [id, op] of activeOperations.entries()) {
    if (now - op.timestamp > OPERATION_TTL_MS) {
      op.controller.abort();
      activeOperations.delete(id);
    }
  }
}, 60_000);

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'build',
  '.output',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  '.nyc_output',
  '.parcel-cache',
]);

// Files to ignore
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

// File extensions to ignore
const IGNORED_EXTENSIONS = new Set([
  '.log',
  '.lock', // We'll handle package-lock.json separately
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.obj',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
]);

// Lock files to keep (not ignore)
const ALLOWED_LOCK_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function isIgnoredFileByName(name: string): boolean {
  if (IGNORED_FILES.has(name)) return true;
  const ext = name.includes('.') ? `.${name.split('.').pop()?.toLowerCase()}` : '';
  if (!IGNORED_EXTENSIONS.has(ext)) return false;
  return !ALLOWED_LOCK_FILES.has(name);
}

/**
 * Shared validation & path resolution for cross-project copy/move.
 * Handles security checks, conflict detection, overwrite, and keep-both (auto-rename).
 */
async function resolveCrossProjectPaths(input: {
  sourceProjectPath: string;
  sourcePath: string;
  destProjectPath: string;
  destFolder: string;
  overwrite: boolean;
  keepBoth: boolean;
}): Promise<{
  absoluteSource: string;
  absoluteDest: string;
  destProjectPath: string;
}> {
  const { sourceProjectPath, sourcePath, destProjectPath, destFolder, overwrite, keepBoth } = input;

  // Security: Reject path traversal
  if (sourcePath.includes('..') || destFolder.includes('..')) {
    throw new Error('Invalid path: traversal not allowed');
  }

  const absoluteSource = join(sourceProjectPath, sourcePath);
  const sourceFileName = basename(sourcePath);
  const absoluteDestFolder = destFolder ? join(destProjectPath, destFolder) : destProjectPath;
  let absoluteDest = join(absoluteDestFolder, sourceFileName);

  // Security: Ensure paths resolve within their respective projects
  if (!absoluteSource.startsWith(sourceProjectPath)) {
    throw new Error('Access denied: source path outside project');
  }
  if (!absoluteDest.startsWith(destProjectPath)) {
    throw new Error('Access denied: destination path outside project');
  }

  // Validate source exists
  try {
    await access(absoluteSource);
  } catch {
    throw new Error(`Source not found: ${sourcePath}`);
  }

  // Ensure destination folder exists
  await mkdir(absoluteDestFolder, { recursive: true });

  // Handle name conflict
  if (existsSync(absoluteDest)) {
    if (overwrite) {
      await rm(absoluteDest, { recursive: true, force: true });
    } else if (keepBoth) {
      absoluteDest = findAvailableName(absoluteDest);
    } else {
      throw new Error(`File already exists at destination: ${sourceFileName}`);
    }
  }

  return { absoluteSource, absoluteDest, destProjectPath };
}

/**
 * Find the next available name by appending a numeric suffix.
 * e.g. "file.txt" → "file (1).txt", "folder" → "folder (1)"
 */
function findAvailableName(destPath: string): string {
  const ext = extname(destPath);
  const base = ext ? destPath.slice(0, -ext.length) : destPath;
  let counter = 1;
  let candidate = `${base} (${counter})${ext}`;
  while (existsSync(candidate)) {
    counter++;
    candidate = `${base} (${counter})${ext}`;
  }
  return candidate;
}

/**
 * Sanitize filesystem errors — only expose known safe error codes, never raw messages.
 * Prevents leaking internal paths, OS details, or library internals.
 */
function sanitizeFileError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code) {
      switch (code) {
        case 'ENOENT':
          return 'File or folder not found';
        case 'EACCES':
        case 'EPERM':
          return 'Permission denied';
        case 'ENOTEMPTY':
          return 'Directory not empty';
        case 'EBUSY':
          return 'File is in use';
        case 'EISDIR':
          return 'Is a directory';
        case 'ENOSPC':
          return 'No space left on device';
        default:
          return 'File operation failed';
      }
    }
    // Allow our own safe, controlled error messages through
    if (
      error.message.startsWith('File already exists') ||
      error.message.startsWith('Source not found') ||
      error.message.startsWith('Access denied') ||
      error.message.startsWith('Invalid path') ||
      error.message.startsWith('Cannot undo') ||
      error.message === 'Operation cancelled' ||
      error.message.startsWith('Operation timed out')
    ) {
      return error.message;
    }
  }
  return 'File operation failed';
}

/**
 * Validate a relative path within a project — reusable across all batch operations.
 * Wraps the security module's `resolvePathInWorktree` in a Result type (non-throwing)
 * for per-item batch error aggregation.
 */
function validateRelativePath(
  projectPath: string,
  relativePath: string,
): { valid: true; absolutePath: string } | { valid: false; error: string } {
  try {
    const absolutePath = resolvePathInWorktree(projectPath, relativePath, { allowRoot: true });
    // Extra guard: ensure resolved path stays within project
    if (!absolutePath.startsWith(`${projectPath}/`) && absolutePath !== projectPath) {
      return { valid: false, error: 'Access denied: path outside project' };
    }
    return { valid: true, absolutePath };
  } catch (error) {
    if (error instanceof PathValidationError) {
      return { valid: false, error: error.message };
    }
    return { valid: false, error: 'Invalid path' };
  }
}

/** Concurrency limit for batch file operations (avoids disk I/O saturation) */
const BATCH_CONCURRENCY = 5;
/** Per-batch timeout (5 minutes) — applies to the whole batch operation */
const BATCH_TIMEOUT_MS = 5 * 60 * 1000;

/** Send progress to the specific window that initiated the operation (falls back to broadcast) */
function sendProgress(
  payload: {
    operationId: string;
    current: number;
    total: number;
    currentFile: string;
    done: boolean;
  },
  targetWebContentsId?: number,
) {
  if (targetWebContentsId) {
    // Target the specific window that initiated the operation
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.id === targetWebContentsId) {
        win.webContents.send('files:operation-progress', payload);
        return;
      }
    }
  }
  // Fallback: broadcast to all windows
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('files:operation-progress', payload);
    }
  }
}

/** Recursively list all files inside a directory (for progress counting).
 *  Skips symbolic links to prevent symlink-escape attacks. */
async function listAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    // Security: skip symlinks to prevent copying data from outside the project
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAllFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** Options for copyWithProgress */
type CopyProgressOpts = {
  operationId: string;
  /** webContents ID of the window to send progress to */
  targetWebContentsId?: number;
  /** AbortSignal to cancel the operation */
  signal?: AbortSignal;
};

/** Timeout for copy operations (5 minutes) */
const COPY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Copy a directory tree with per-file progress events.
 * Falls back to `cp()` for single files.
 * Supports cancellation via AbortSignal and a 5-minute timeout.
 */
async function copyWithProgress(
  source: string,
  dest: string,
  opts: CopyProgressOpts,
): Promise<void> {
  const { operationId, targetWebContentsId, signal } = opts;
  const srcStat = await stat(source);

  // Set up timeout
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), COPY_TIMEOUT_MS);

  const isAborted = () => signal?.aborted || timeoutController.signal.aborted;

  try {
    if (!srcStat.isDirectory()) {
      // Single file — no progress needed
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(source, dest);
      sendProgress(
        { operationId, current: 1, total: 1, currentFile: basename(source), done: true },
        targetWebContentsId,
      );
      return;
    }

    // Directory — walk, count, copy with progress
    const allFiles = await listAllFiles(source);
    const total = allFiles.length;

    if (total === 0) {
      // Empty directory
      await mkdir(dest, { recursive: true });
      sendProgress(
        { operationId, current: 0, total: 0, currentFile: '', done: true },
        targetWebContentsId,
      );
      return;
    }

    let current = 0;
    for (const filePath of allFiles) {
      // Throttle abort check to every 10 files for performance
      if (current % 10 === 0 && isAborted()) {
        throw new Error(
          signal?.aborted ? 'Operation cancelled' : 'Operation timed out (5 minutes)',
        );
      }

      const relativePath = relative(source, filePath);
      const destFile = join(dest, relativePath);
      await mkdir(dirname(destFile), { recursive: true });
      await copyFile(filePath, destFile);
      current++;

      // Emit progress every 10 files (throttled for performance)
      if (current % 10 === 0 || current === total) {
        sendProgress(
          { operationId, current, total, currentFile: relativePath, done: current === total },
          targetWebContentsId,
        );
      }
    }

    // Ensure a final done event is sent
    if (total % 10 !== 0) {
      sendProgress(
        {
          operationId,
          current: total,
          total,
          currentFile:
            allFiles.length > 0 ? relative(source, allFiles[allFiles.length - 1] ?? '') : '',
          done: true,
        },
        targetWebContentsId,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Entry type for files and folders
type FileEntry = {
  path: string;
  type: 'file' | 'folder';
  gitStatus?: FileStatus;
  isGitIgnored?: boolean;
};

// Cache for file and folder listings
const fileListCache = new Map<string, { entries: FileEntry[]; timestamp: number }>();
const CACHE_TTL = 30000; // 30 seconds
const MAX_CONTENT_SEARCH_FILE_BYTES = 512 * 1024; // 512KB per file
const MAX_CONTENT_SEARCH_LINE_LENGTH = 500;

// Cache for git status per project
const gitStatusCache = new Map<string, { statusMap: Map<string, FileStatus>; timestamp: number }>();
const GIT_STATUS_CACHE_TTL = 5000; // 5 seconds for git status

/**
 * Invalidate git status cache for a project
 * Called by git watcher when git operations occur
 */
export function invalidateGitStatusCache(projectPath: string): void {
  gitStatusCache.delete(projectPath);
}

/**
 * Invalidate every cached base that contains `filePath`.
 * The cache is keyed by the base the renderer browsed — a project root or a
 * worktree root — and a file can sit under both, so all containing keys drop.
 */
function invalidateGitStatusCacheContaining(filePath: string): void {
  for (const base of gitStatusCache.keys()) {
    if (filePath === base || filePath.startsWith(base + sep)) {
      gitStatusCache.delete(base);
    }
  }
}

/**
 * Invalidate file tree search cache for a project.
 * Called when external changes may make cached listings stale.
 */
export function invalidateFileListCache(projectPath: string): void {
  fileListCache.delete(projectPath);
}

/**
 * Get git status for all files in a project (with caching)
 * Returns a Map of file path -> git status
 */
async function getGitStatusMap(projectPath: string): Promise<Map<string, FileStatus>> {
  // Check cache first
  const cached = gitStatusCache.get(projectPath);
  const now = Date.now();

  if (cached && now - cached.timestamp < GIT_STATUS_CACHE_TTL) {
    return cached.statusMap;
  }

  const statusMap = new Map<string, FileStatus>();

  try {
    const git = simpleGit(projectPath);
    const status = await git.status();
    const parsed = parseGitStatus(status);

    // Add staged files (normalize path so folder/prefix checks work on all platforms)
    for (const file of parsed.staged) {
      statusMap.set(normalizePathForGit(file.path), file.status);
    }

    // Add unstaged files
    for (const file of parsed.unstaged) {
      statusMap.set(normalizePathForGit(file.path), file.status);
    }

    // Add untracked files
    for (const file of parsed.untracked) {
      statusMap.set(normalizePathForGit(file.path), file.status);
    }

    // Cache the result
    gitStatusCache.set(projectPath, { statusMap, timestamp: now });
  } catch {
    // Not a git repository or git failed - return empty map
  }

  return statusMap;
}

/**
 * Sanitize filename for safe git command usage
 * Removes control characters, newlines, and null bytes
 */
function sanitizeFilename(filename: string): string {
  // Remove control characters by filtering out chars with code < 32 or code === 127
  return filename
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
}

/**
 * Check if files are git ignored
 * Returns a Set of ignored file paths
 */
async function getGitIgnoredFiles(projectPath: string, filePaths: string[]): Promise<Set<string>> {
  const ignoredFiles = new Set<string>();

  if (filePaths.length === 0) return ignoredFiles;

  try {
    const git = simpleGit(projectPath);
    // Sanitize filenames to prevent command injection
    const sanitizedPaths = filePaths.map(sanitizeFilename);
    // Use git check-ignore to check multiple files at once
    const result = await git.raw(['check-ignore', '--', ...sanitizedPaths]);
    // Result contains newline-separated list of ignored files
    if (result) {
      const ignored = result.trim().split('\n').filter(Boolean);
      for (const file of ignored) {
        ignoredFiles.add(file);
        // Also add normalized version for matching
        ignoredFiles.add(normalizePathForGit(file));
      }
      // Also try matching with original paths normalized
      for (const filePath of filePaths) {
        const normalized = normalizePathForGit(filePath);
        if (ignored.some((ignoredPath) => normalizePathForGit(ignoredPath) === normalized)) {
          ignoredFiles.add(filePath);
          ignoredFiles.add(normalized);
        }
      }
    }
  } catch {
    // Not a git repository or git check-ignore failed - return empty set
  }

  return ignoredFiles;
}

/** Normalize path to forward slashes so git status map lookups match (git uses / on all platforms) */
function normalizePathForGit(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * List immediate children of a directory (single level, no recursion)
 * Used for lazy loading - only fetches one level at a time like VSCode
 */
async function listDirectoryContents(
  dirPath: string,
  rootPath: string,
  gitStatusMap?: Map<string, FileStatus>,
  gitIgnoredSet?: Set<string>,
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  try {
    const dirEntries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of dirEntries) {
      const fullPath = join(dirPath, entry.name);
      const relativePath = relative(rootPath, fullPath);
      const relativePathNorm = normalizePathForGit(relativePath);

      if (entry.isDirectory()) {
        // Skip ignored directories
        if (isIgnoredDirectory(entry.name)) continue;

        // Check if folder contains any modified files (use normalized paths - git uses / on all platforms)
        let folderGitStatus: FileStatus | undefined = gitStatusMap?.get(relativePathNorm);
        if (!folderGitStatus && gitStatusMap) {
          const folderPrefix = relativePathNorm ? `${relativePathNorm}/` : '';
          for (const [mapPath] of gitStatusMap) {
            if (normalizePathForGit(mapPath).startsWith(folderPrefix)) {
              folderGitStatus = 'modified'; // Mark folder as modified if it contains changes
              break;
            }
          }
        }

        const isGitIgnored = gitIgnoredSet?.has(relativePath);
        entries.push({
          path: relativePath,
          type: 'folder',
          gitStatus: folderGitStatus,
          isGitIgnored,
        });
      } else if (entry.isFile()) {
        // Skip ignored files
        if (isIgnoredFileByName(entry.name)) continue;

        const gitStatus = gitStatusMap?.get(relativePathNorm);
        const isGitIgnored = gitIgnoredSet?.has(relativePath);
        entries.push({ path: relativePath, type: 'file', gitStatus, isGitIgnored });
      }
    }

    // Sort: folders first, then alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return basename(a.path).localeCompare(basename(b.path));
    });
  } catch {
    // Silently skip directories we can't read (permissions, etc.)
  }

  return entries;
}

/**
 * Ceiling on entries a single tree scan will collect. The router accepts whatever
 * root the renderer names, so a mistaken root (`/`, a home directory) must cost a
 * bounded amount of main-process work and memory rather than walking to maxDepth.
 */
const MAX_SCAN_ENTRIES = 200_000;

/**
 * Recursively scan a directory and return all file and folder paths
 * Used for search mode - scans entire tree to find matches
 */
async function scanDirectory(
  rootPath: string,
  currentPath: string = rootPath,
  depth: number = 0,
  maxDepth: number = 15,
  budget: { remaining: number } = { remaining: MAX_SCAN_ENTRIES },
): Promise<FileEntry[]> {
  if (depth > maxDepth || budget.remaining <= 0) return [];

  const entries: FileEntry[] = [];

  try {
    const dirEntries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (budget.remaining <= 0) break;
      const fullPath = join(currentPath, entry.name);
      const relativePath = relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        // Skip ignored directories
        if (isIgnoredDirectory(entry.name)) continue;
        // Add the folder itself to results
        entries.push({ path: relativePath, type: 'folder' });
        budget.remaining--;

        // Recurse into subdirectory
        const subEntries = await scanDirectory(rootPath, fullPath, depth + 1, maxDepth, budget);
        entries.push(...subEntries);
      } else if (entry.isFile()) {
        // Skip ignored files
        if (isIgnoredFileByName(entry.name)) continue;

        entries.push({ path: relativePath, type: 'file' });
        budget.remaining--;
      }
    }
  } catch {
    // Silently skip directories we can't scan (permissions, etc.)
  }

  return entries;
}

/**
 * Get cached entry list or scan directory
 */
async function getEntryList(projectPath: string): Promise<FileEntry[]> {
  const cached = fileListCache.get(projectPath);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.entries;
  }

  const entries = await scanDirectory(projectPath);
  fileListCache.set(projectPath, { entries, timestamp: now });

  return entries;
}

/**
 * Filter and sort entries (files and folders) by query
 */
function filterEntries(
  entries: FileEntry[],
  query: string,
): Array<{ id: string; label: string; path: string; repository: string; type: 'file' | 'folder' }> {
  const queryLower = query.toLowerCase();

  // Filter entries that match the query
  let filtered = entries;
  if (query) {
    filtered = entries.filter((entry) => {
      const name = basename(entry.path).toLowerCase();
      const pathLower = entry.path.toLowerCase();
      return name.includes(queryLower) || pathLower.includes(queryLower);
    });
  }

  // Sort by relevance (exact match > starts with > shorter match > contains > alphabetical)
  // Files and folders are treated equally
  filtered.sort((a, b) => {
    const aName = basename(a.path).toLowerCase();
    const bName = basename(b.path).toLowerCase();

    if (query) {
      // Priority 1: Exact name match
      const aExact = aName === queryLower;
      const bExact = bName === queryLower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // Priority 2: Name starts with query
      const aStarts = aName.startsWith(queryLower);
      const bStarts = bName.startsWith(queryLower);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      // Priority 3: If both start with query, shorter name = better match
      if (aStarts && bStarts) {
        if (aName.length !== bName.length) {
          return aName.length - bName.length;
        }
      }

      // Priority 4: Name contains query (but doesn't start with it)
      const aContains = aName.includes(queryLower);
      const bContains = bName.includes(queryLower);
      if (aContains && !bContains) return -1;
      if (!aContains && bContains) return 1;
    }

    // Alphabetical by name
    return aName.localeCompare(bName);
  });

  // Map to expected format with type
  return filtered.map((entry) => ({
    id: `${entry.type}:local:${entry.path}`,
    label: basename(entry.path),
    path: entry.path,
    repository: 'local',
    type: entry.type,
  }));
}

export type FileContentMatch = {
  id: string;
  filePath: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  lineText: string;
};

type SearchContentOptions = {
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
};

/** Keep content search output lightweight and stable for rendering. */
function truncateSearchText(text: string, matchStartColumn?: number): string {
  if (text.length <= MAX_CONTENT_SEARCH_LINE_LENGTH) return text;
  if (!matchStartColumn || matchStartColumn <= 1) {
    return `${text.slice(0, MAX_CONTENT_SEARCH_LINE_LENGTH)}...`;
  }

  const matchIndex = Math.max(0, matchStartColumn - 1);
  const preferredStart = Math.max(0, matchIndex - Math.floor(MAX_CONTENT_SEARCH_LINE_LENGTH / 2));
  const maxStart = Math.max(0, text.length - MAX_CONTENT_SEARCH_LINE_LENGTH);
  const start = Math.min(preferredStart, maxStart);
  const end = Math.min(start + MAX_CONTENT_SEARCH_LINE_LENGTH, text.length);
  const snippet = text.slice(start, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${snippet}${suffix}`;
}

type ContentSearchLineMatch = {
  startColumn: number;
  endColumn: number;
};

function createContentSearchMatcher(
  query: string,
  options: SearchContentOptions,
): ((line: string) => ContentSearchLineMatch[]) | null {
  const { matchCase, wholeWord, useRegex } = options;

  if (useRegex) {
    try {
      const flags = matchCase ? '' : 'i';
      const pattern = wholeWord ? `\\b(?:${query})\\b` : query;
      const regex = new RegExp(pattern, `${flags}g`);
      return (line: string) => {
        regex.lastIndex = 0;
        const matches: ContentSearchLineMatch[] = [];
        let match: RegExpExecArray | null = regex.exec(line);
        while (match) {
          if (typeof match.index === 'number') {
            const startColumn = match.index + 1;
            const endColumn = startColumn + (match[0]?.length ?? 0);
            matches.push({ startColumn, endColumn });
            // Prevent infinite loops on zero-length regex matches.
            if ((match[0]?.length ?? 0) === 0) {
              regex.lastIndex += 1;
            }
          }
          match = regex.exec(line);
        }
        return matches;
      };
    } catch {
      return null;
    }
  }

  const source = wholeWord ? `\\b${escapeRegExp(query)}\\b` : escapeRegExp(query);
  const flags = matchCase ? '' : 'i';
  const regex = new RegExp(source, `${flags}g`);
  return (line: string) => {
    regex.lastIndex = 0;
    const matches: ContentSearchLineMatch[] = [];
    let match: RegExpExecArray | null = regex.exec(line);
    while (match) {
      if (typeof match.index === 'number') {
        const startColumn = match.index + 1;
        const endColumn = startColumn + (match[0]?.length ?? 0);
        matches.push({ startColumn, endColumn });
        if ((match[0]?.length ?? 0) === 0) {
          regex.lastIndex += 1;
        }
      }
      match = regex.exec(line);
    }
    return matches;
  };
}

/**
 * Recursively search file contents for query matches.
 * Applies the same ignore policy as file tree search and hard caps file size.
 */
async function searchDirectoryContents(
  rootPath: string,
  matcher: (line: string) => ContentSearchLineMatch[],
  limit: number,
  currentPath: string = rootPath,
  depth: number = 0,
  maxDepth: number = 15,
  results: FileContentMatch[] = [],
): Promise<FileContentMatch[]> {
  if (depth > maxDepth || results.length >= limit) return results;

  let dirEntries = [];
  try {
    dirEntries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of dirEntries) {
    if (results.length >= limit) break;

    const fullPath = join(currentPath, entry.name);
    const relativePath = relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      if (isIgnoredDirectory(entry.name)) continue;
      await searchDirectoryContents(
        rootPath,
        matcher,
        limit,
        fullPath,
        depth + 1,
        maxDepth,
        results,
      );
      continue;
    }

    if (!entry.isFile()) continue;
    if (isIgnoredFileByName(entry.name)) continue;

    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile() || fileStat.size > MAX_CONTENT_SEARCH_FILE_BYTES) {
        continue;
      }
      const content = await readFile(fullPath, 'utf-8');
      if (content.includes('\u0000')) continue;

      const lines = content.split(LINE_ENDING_REGEX);
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        const line = lines[i] ?? '';
        const lineMatches = matcher(line);
        if (lineMatches.length === 0) continue;

        for (
          let matchIndex = 0;
          matchIndex < lineMatches.length && results.length < limit;
          matchIndex++
        ) {
          const lineMatch = lineMatches[matchIndex];
          if (!lineMatch) continue;
          results.push({
            id: `content:local:${relativePath}:${i + 1}:${lineMatch.startColumn}:${matchIndex}`,
            filePath: relativePath,
            lineNumber: i + 1,
            startColumn: lineMatch.startColumn,
            endColumn: lineMatch.endColumn,
            lineText: truncateSearchText(line, lineMatch.startColumn),
          });
        }
      }
    } catch {
      // Skip unreadable/binary-like files silently.
    }
  }

  return results;
}

export const filesRouter = router({
  /**
   * Search files and folders in a local project directory
   */
  search: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        query: z.string().default(''),
        limit: z.number().min(1).max(10000).default(5000),
      }),
    )
    .query(async ({ input }) => {
      const { projectPath, query, limit } = input;

      if (!projectPath) {
        return [];
      }

      try {
        // Verify the path exists and is a directory
        const pathStat = await stat(projectPath);
        if (!pathStat.isDirectory()) {
          return [];
        }

        // Get entry list (cached or fresh scan)
        const entries = await getEntryList(projectPath);

        // Filter and sort by query, then apply limit
        const results = filterEntries(entries, query);
        return results.slice(0, limit);
      } catch (_error) {
        return [];
      }
    }),

  /**
   * Search inside local file contents (VS Code style find-in-files).
   */
  searchContent: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        query: z.string().trim().min(1),
        limit: z.number().min(1).max(500).default(200),
        matchCase: z.boolean().default(false),
        wholeWord: z.boolean().default(false),
        useRegex: z.boolean().default(false),
      }),
    )
    .query(async ({ input }) => {
      const { projectPath, query, limit, matchCase, wholeWord, useRegex } = input;

      if (!projectPath) {
        return { matches: [], invalidRegex: false };
      }

      try {
        const pathStat = await stat(projectPath);
        if (!pathStat.isDirectory()) {
          return { matches: [], invalidRegex: false };
        }
        const matcher = createContentSearchMatcher(query, {
          matchCase,
          wholeWord,
          useRegex,
        });
        if (!matcher) {
          return { matches: [], invalidRegex: useRegex };
        }
        const matches = await searchDirectoryContents(projectPath, matcher, limit);
        return { matches, invalidRegex: false };
      } catch {
        return { matches: [], invalidRegex: false };
      }
    }),

  /**
   * Clear the file cache for a project (useful when files change)
   */
  clearCache: publicProcedure.input(z.object({ projectPath: z.string() })).mutation(({ input }) => {
    invalidateFileListCache(input.projectPath);
    return { success: true };
  }),

  /**
   * Clear the module-resolver tsconfig cache (e.g. after editing tsconfig.json)
   */
  clearResolverCache: publicProcedure.mutation(async () => {
    const { clearResolverCache } = await import('../../module-resolver');
    clearResolverCache();
    return { success: true };
  }),

  /**
   * Clear the git status cache for a project (useful when git operations happen)
   */
  clearGitCache: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .mutation(({ input }) => {
      gitStatusCache.delete(input.projectPath);
      return { success: true };
    }),

  /**
   * List contents of a directory (lazy loading - single level only)
   * Used by file tree to fetch children on expand, like VSCode
   */
  listDirectory: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        relativePath: z.string().default(''), // Empty string = root
      }),
    )
    .query(async ({ input }) => {
      const { projectPath, relativePath } = input;

      if (!projectPath) {
        return [];
      }

      // Security: Reject path traversal in relativePath
      if (relativePath.includes('..')) {
        return [];
      }

      const targetPath = resolve(join(projectPath, relativePath));

      try {
        const pathStat = await stat(targetPath);
        if (!pathStat.isDirectory()) {
          return [];
        }

        // Get git status for the entire project
        const gitStatusMap = await getGitStatusMap(projectPath);

        const entries = await listDirectoryContents(targetPath, projectPath, gitStatusMap);

        // Check which files are git ignored
        const filePaths = entries.map((e) => e.path);
        const gitIgnoredSet = await getGitIgnoredFiles(projectPath, filePaths);

        // Map to expected format with ignored status
        // Normalize paths for comparison (git uses / on all platforms)
        const normalizedIgnoredSet = new Set(
          Array.from(gitIgnoredSet).map((p) => normalizePathForGit(p)),
        );
        return entries.map((entry) => {
          const normalizedPath = normalizePathForGit(entry.path);
          const isIgnored =
            gitIgnoredSet.has(entry.path) || normalizedIgnoredSet.has(normalizedPath);
          return {
            name: basename(entry.path),
            path: entry.path,
            type: entry.type,
            gitStatus: entry.gitStatus,
            isGitIgnored: isIgnored,
          };
        });
      } catch {
        return [];
      }
    }),

  /**
   * Read file contents from filesystem
   */
  readFile: publicProcedure.input(z.object({ filePath: z.string() })).query(async ({ input }) => {
    const { filePath } = input;

    try {
      const content = await readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      throw new Error(
        `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }),

  /**
   * Read image file as base64 data URL for display in the code editor panel.
   * Only allowed image extensions; 20MB size limit.
   */
  readImageFile: publicProcedure
    .input(z.object({ filePath: z.string() }))
    .query(async ({ input }) => {
      const { filePath } = input;

      if (!isImagePath(filePath)) {
        throw new Error('Not an allowed image type');
      }

      const mimeType = getImageMimeType(filePath);
      if (!mimeType) {
        throw new Error('Not an allowed image type');
      }

      const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB raw (~10.7MB base64)
      const MAX_DATA_URL_BYTES = 12 * 1024 * 1024; // hard cap for IPC payload size
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          throw new Error('Not a file');
        }
        if (fileStat.size > MAX_IMAGE_BYTES) {
          throw new Error('Image too large to display (max 8MB)');
        }

        const dataUrlPrefix = `data:${mimeType};base64,`;
        const estimatedBase64Bytes = Math.ceil(fileStat.size / 3) * 4;
        const estimatedDataUrlBytes = dataUrlPrefix.length + estimatedBase64Bytes;
        if (estimatedDataUrlBytes > MAX_DATA_URL_BYTES) {
          throw new Error('Image too large to display (payload limit exceeded)');
        }

        // Read directly as base64 to avoid holding both Buffer and encoded string in userland.
        const base64 = await readFile(filePath, { encoding: 'base64' });
        const dataUrl = `${dataUrlPrefix}${base64}`;
        return { dataUrl };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith('Image too large') || error.message.includes('payload limit'))
        ) {
          throw error;
        }
        throw new Error(sanitizeFileError(error));
      }
    }),

  /**
   * Read PDF file as base64 for display in the code editor panel (frontend creates blob URL).
   * Only .pdf extension; size limit per MAX_PDF_BYTES.
   */
  readPdfFile: publicProcedure
    .input(z.object({ filePath: z.string() }))
    .query(async ({ input }) => {
      const { filePath } = input;

      if (!isPdfPath(filePath)) {
        throw new Error('Not a PDF file');
      }

      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          throw new Error('Not a file');
        }
        if (fileStat.size > MAX_PDF_BYTES) {
          throw new Error(`PDF too large to display (max ${MAX_PDF_BYTES / (1024 * 1024)}MB)`);
        }

        // Guard IPC payload size (base64 expands by ~4/3).
        const MAX_BASE64_PAYLOAD_BYTES = 12 * 1024 * 1024;
        const estimatedBase64Bytes = Math.ceil(fileStat.size / 3) * 4;
        if (estimatedBase64Bytes > MAX_BASE64_PAYLOAD_BYTES) {
          throw new Error('PDF too large to display (payload limit exceeded)');
        }

        const base64 = await readFile(filePath, { encoding: 'base64' });
        return { base64 };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith('PDF too large to display') ||
            error.message.includes('payload limit'))
        ) {
          throw error;
        }
        throw new Error(sanitizeFileError(error));
      }
    }),

  /**
   * Write file contents to filesystem (used by code editor save)
   */
  writeFile: publicProcedure
    .input(z.object({ filePath: z.string(), content: z.string() }))
    .mutation(async ({ input }) => {
      const { filePath, content } = input;

      try {
        await writeFile(filePath, content, 'utf-8');

        invalidateGitStatusCacheContaining(filePath);

        return { success: true };
      } catch (error) {
        throw new Error(
          `Failed to write file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }),

  /**
   * Move a file or folder within a project directory
   * Used by file tree drag-and-drop
   */
  moveFile: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        /** Relative path of the file/folder to move (from project root) */
        sourcePath: z.string(),
        /** Relative path of the destination folder (empty string = project root) */
        destinationFolder: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, sourcePath, destinationFolder } = input;

      // Security: Reject path traversal
      if (sourcePath.includes('..') || destinationFolder.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }

      const absoluteSource = join(projectPath, sourcePath);
      const sourceFileName = basename(sourcePath);
      const absoluteDestFolder = destinationFolder
        ? join(projectPath, destinationFolder)
        : projectPath;
      const absoluteDest = join(absoluteDestFolder, sourceFileName);

      // Security: Ensure both paths resolve within the project
      if (!absoluteSource.startsWith(projectPath)) {
        throw new Error('Access denied: source path outside project');
      }
      if (!absoluteDest.startsWith(projectPath)) {
        throw new Error('Access denied: destination path outside project');
      }

      // Validate source exists
      try {
        await access(absoluteSource);
      } catch {
        throw new Error(`Source not found: ${sourcePath}`);
      }

      // Validate destination folder exists and is a directory
      try {
        const destStat = await stat(absoluteDestFolder);
        if (!destStat.isDirectory()) {
          throw new Error('Destination is not a folder');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Destination is not a folder') throw error;
        throw new Error(`Destination folder not found: ${destinationFolder}`);
      }

      // No-op: source is already in the destination folder
      if (dirname(absoluteSource) === absoluteDestFolder) {
        return { success: true };
      }

      // Prevent moving a folder into itself or its own descendant
      const sourceStat = await stat(absoluteSource);
      if (sourceStat.isDirectory() && absoluteDestFolder.startsWith(`${absoluteSource}/`)) {
        throw new Error('Cannot move a folder into its own descendant');
      }

      // Prevent overwrite: check if a file/folder with the same name already exists at destination
      try {
        await access(absoluteDest);
        // If we get here, destination already exists
        throw new Error(
          `A file or folder named "${sourceFileName}" already exists in the destination`,
        );
      } catch (error) {
        // If it's our own error, re-throw it
        if (error instanceof Error && error.message.includes('already exists')) throw error;
        // Otherwise, destination doesn't exist - good, we can proceed
      }

      // Perform the move (atomic on same filesystem)
      try {
        await rename(absoluteSource, absoluteDest);
      } catch (error) {
        throw new Error(
          `Failed to move file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      // Invalidate caches so the tree refreshes
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      return { success: true };
    }),

  /**
   * Create an empty file within a project directory
   * Used by file tree context menu "New File"
   */
  createFile: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        /** Relative path of the new file (from project root), e.g. "src/utils/helpers.ts" */
        relativePath: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, relativePath } = input;

      // Security: Reject path traversal
      if (relativePath.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }

      const absolutePath = join(projectPath, relativePath);

      // Security: Ensure path resolves within the project
      if (!absolutePath.startsWith(projectPath)) {
        throw new Error('Access denied: path outside project');
      }

      // Check file doesn't already exist
      try {
        await access(absolutePath);
        throw new Error(`File already exists: ${relativePath}`);
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) throw error;
        // File doesn't exist - good
      }

      // Create parent directories if needed, then write empty file
      try {
        const parentDir = dirname(absolutePath);
        await mkdir(parentDir, { recursive: true });
        await writeFile(absolutePath, '', 'utf-8');
      } catch (error) {
        throw new Error(
          `Failed to create file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      // Invalidate caches
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      return { success: true };
    }),

  /**
   * Create a folder within a project directory
   * Used by file tree context menu "New Folder"
   */
  createFolder: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        /** Relative path of the new folder (from project root), e.g. "src/utils" */
        relativePath: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, relativePath } = input;

      // Security: Reject path traversal
      if (relativePath.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }

      const absolutePath = join(projectPath, relativePath);

      // Security: Ensure path resolves within the project
      if (!absolutePath.startsWith(projectPath)) {
        throw new Error('Access denied: path outside project');
      }

      // Check folder doesn't already exist
      try {
        await access(absolutePath);
        throw new Error(`Folder already exists: ${relativePath}`);
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) throw error;
        // Folder doesn't exist - good
      }

      // Create the directory (and parents if needed)
      try {
        await mkdir(absolutePath, { recursive: true });
      } catch (error) {
        throw new Error(
          `Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      // Invalidate caches
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      return { success: true };
    }),

  /**
   * Copy external files or folders into a project directory.
   * Used when user drops files from Finder/Explorer/VSCode into the file tree.
   * Uses fs.cp() in main process — no content over IPC; preserves binary and folder structure.
   */
  copyExternalFiles: publicProcedure
    .input(
      z.object({
        /** Absolute OS paths of files/folders to copy (from webUtils.getPathForFile) */
        sourcePaths: z.array(z.string().min(1)),
        projectPath: z.string(),
        /** Relative destination folder (empty = project root) */
        destinationFolder: z.string(),
        /** How to handle existing files at destination */
        resolution: z.enum(['overwrite', 'skip', 'keepBoth']).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { sourcePaths, projectPath, destinationFolder, resolution } = input;
      const resolvedResolution = resolution ?? 'overwrite';

      if (destinationFolder.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }

      const destDir = destinationFolder ? join(projectPath, destinationFolder) : projectPath;
      if (!destDir.startsWith(projectPath)) {
        throw new Error('Access denied: destination outside project');
      }

      let copied = 0;
      let skipped = 0;
      let renamed = 0;
      const errors: Array<{ path: string; message: string }> = [];

      for (const sourcePath of sourcePaths) {
        if (!isAbsolute(sourcePath)) {
          errors.push({ path: sourcePath, message: 'Path must be absolute' });
          continue;
        }
        let statResult: Awaited<ReturnType<typeof stat>>;
        try {
          statResult = await stat(sourcePath);
        } catch (err) {
          errors.push({
            path: sourcePath,
            message: err instanceof Error ? err.message : 'Not found',
          });
          continue;
        }

        const name = basename(sourcePath);
        let destPath = join(destDir, name);
        let wasRenamed = false;

        if (existsSync(destPath)) {
          if (resolvedResolution === 'skip') {
            skipped += 1;
            continue;
          }
          if (resolvedResolution === 'overwrite') {
            try {
              await rm(destPath, { recursive: true });
            } catch (rmErr) {
              errors.push({
                path: sourcePath,
                message: rmErr instanceof Error ? rmErr.message : 'Failed to remove existing',
              });
              continue;
            }
          }
          if (resolvedResolution === 'keepBoth') {
            const ext = extname(name);
            const base = name.slice(0, name.length - ext.length);
            let n = 1;
            while (existsSync(destPath)) {
              destPath = join(destDir, `${base} (${n})${ext}`);
              n += 1;
            }
            wasRenamed = true;
          }
        }

        try {
          await mkdir(dirname(destPath), { recursive: true });
          if (statResult.isDirectory()) {
            await cp(sourcePath, destPath, { recursive: true });
          } else {
            await cp(sourcePath, destPath);
          }
          copied += 1;
          if (wasRenamed) renamed += 1;
        } catch (err) {
          errors.push({
            path: sourcePath,
            message: err instanceof Error ? err.message : 'Copy failed',
          });
        }
      }

      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      return { copied, skipped, renamed, errors };
    }),

  /**
   * Delete a file or folder within a project directory
   * Used by file tree context menu "Delete"
   */
  deleteFile: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        /** Relative path of the file/folder to delete (from project root) */
        relativePath: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, relativePath } = input;

      // Security: Reject path traversal and absolute paths
      if (relativePath.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }
      if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
        throw new Error('Invalid path: must be relative');
      }

      const absolutePath = join(projectPath, relativePath);

      // Security: Ensure resolved path stays within the project boundary
      if (!absolutePath.startsWith(`${projectPath}/`)) {
        throw new Error('Access denied: path outside project');
      }

      // Verify the target exists
      try {
        await access(absolutePath);
      } catch {
        throw new Error(`File or folder not found: ${relativePath}`);
      }

      try {
        await shell.trashItem(absolutePath); // never rm(): a failed trash must stay recoverable
      } catch (error) {
        throw new Error(
          `Failed to move to Trash: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      // Invalidate caches
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      return { success: true };
    }),

  /**
   * Batch delete multiple files/folders within a project directory.
   * Returns per-item results so the frontend can report partial failures.
   */
  batchDeleteFiles: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        relativePaths: z.array(z.string().min(1)).min(1).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, relativePaths } = input;

      const results: Array<{ path: string; success: boolean; error?: string }> = [];

      // Process with bounded concurrency
      let index = 0;
      const workers = Array.from(
        { length: Math.min(BATCH_CONCURRENCY, relativePaths.length) },
        async () => {
          while (index < relativePaths.length) {
            const i = index++;
            const relativePath = relativePaths[i];

            const validation = validateRelativePath(projectPath, relativePath);
            if (!validation.valid) {
              results[i] = { path: relativePath, success: false, error: validation.error };
              continue;
            }

            try {
              await access(validation.absolutePath);
              await shell.trashItem(validation.absolutePath);
              results[i] = { path: relativePath, success: true };
            } catch (error) {
              // Per-item failure is reported to the user but never crashes the
              // batch — capture it or a broken trash (e.g. no Linux daemon) is invisible.
              captureMainException(error, { area: 'files-batch-delete' });
              results[i] = { path: relativePath, success: false, error: sanitizeFileError(error) };
            }
          }
        },
      );
      await Promise.all(workers);

      // Invalidate caches once after all deletes
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      return { results };
    }),

  /**
   * Batch move files/folders within the same project.
   * Returns per-item results so the frontend can show consolidated feedback.
   */
  batchMoveFiles: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        /** Relative paths of files/folders to move */
        sourcePaths: z.array(z.string()).min(1).max(200),
        /** Relative destination folder (empty string = project root) */
        destinationFolder: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, sourcePaths, destinationFolder } = input;

      // Validate destination folder
      const destValidation = validateRelativePath(projectPath, destinationFolder || '.');
      if (!destValidation.valid) {
        throw new Error(destValidation.error);
      }
      const absoluteDestFolder = destinationFolder
        ? join(projectPath, destinationFolder)
        : projectPath;
      if (!absoluteDestFolder.startsWith(projectPath)) {
        throw new Error('Access denied: destination outside project');
      }

      try {
        const destStat = await stat(absoluteDestFolder);
        if (!destStat.isDirectory()) {
          throw new Error('Destination is not a folder');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Destination is not a folder') throw error;
        throw new Error('Destination folder not found');
      }

      const results: Array<{
        sourcePath: string;
        destPath?: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const sourcePath of sourcePaths) {
        const validation = validateRelativePath(projectPath, sourcePath);
        if (!validation.valid) {
          results.push({ sourcePath, success: false, error: validation.error });
          continue;
        }

        const absoluteSource = validation.absolutePath;
        const sourceFileName = basename(sourcePath);
        const absoluteDest = join(absoluteDestFolder, sourceFileName);

        // Skip no-ops (source already in destination)
        if (dirname(absoluteSource) === absoluteDestFolder) {
          results.push({ sourcePath, success: true });
          continue;
        }

        // Prevent moving folder into itself
        try {
          const srcStat = await stat(absoluteSource);
          if (srcStat.isDirectory() && absoluteDestFolder.startsWith(`${absoluteSource}/`)) {
            results.push({ sourcePath, success: false, error: 'Cannot move folder into itself' });
            continue;
          }
        } catch {
          results.push({ sourcePath, success: false, error: 'Source not found' });
          continue;
        }

        // Check for name collision
        try {
          await access(absoluteDest);
          results.push({
            sourcePath,
            success: false,
            error: `"${sourceFileName}" already exists in destination`,
          });
          continue;
        } catch {
          // Good — destination doesn't exist
        }

        try {
          await rename(absoluteSource, absoluteDest);
          const destPath = relative(projectPath, absoluteDest);
          results.push({ sourcePath, destPath, success: true });
        } catch (error) {
          results.push({ sourcePath, success: false, error: sanitizeFileError(error) });
        }
      }

      // Invalidate caches once after all moves
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      return { results };
    }),

  /**
   * Rename a file or folder within a project directory
   * Used by file tree inline rename (Enter / F2)
   */
  renameFile: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        /** Relative path of the file/folder to rename */
        relativePath: z.string().min(1),
        /** New name (just the filename, not a path) */
        newName: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, relativePath, newName } = input;

      // Security: Reject path traversal and absolute paths
      if (relativePath.includes('..') || newName.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }
      if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
        throw new Error('Invalid path: must be relative');
      }
      if (newName.includes('/') || newName.includes('\\')) {
        throw new Error('Invalid name: must not contain path separators');
      }

      const absoluteSource = join(projectPath, relativePath);
      const parentDir = dirname(absoluteSource);
      const absoluteDest = join(parentDir, newName);

      // Security: Ensure both paths resolve within the project boundary
      if (!absoluteSource.startsWith(`${projectPath}/`)) {
        throw new Error('Access denied: source path outside project');
      }
      if (!absoluteDest.startsWith(`${projectPath}/`)) {
        throw new Error('Access denied: destination path outside project');
      }

      // Verify source exists
      try {
        await access(absoluteSource);
      } catch {
        throw new Error(`File or folder not found: ${relativePath}`);
      }

      // Check destination doesn't already exist
      try {
        await access(absoluteDest);
        throw new Error(`A file or folder named "${newName}" already exists`);
      } catch (error) {
        if (error instanceof Error && error.message.includes('already exists')) throw error;
        // Doesn't exist — good
      }

      // Perform the rename
      try {
        await rename(absoluteSource, absoluteDest);
      } catch (_error) {
        throw new Error('Failed to rename file. Please check permissions and try again.');
      }

      // Invalidate caches
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      // Return the new relative path
      const newRelativePath = relative(projectPath, absoluteDest);
      return { success: true, newPath: newRelativePath };
    }),

  /**
   * Duplicate a file or folder within a project directory
   * Used by file tree keyboard shortcut (Cmd+D)
   */
  duplicateFile: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        /** Relative path of the file/folder to duplicate */
        relativePath: z.string().min(1),
        /** Relative destination folder (empty string = project root, omitted = source folder) */
        destinationFolder: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { projectPath, relativePath, destinationFolder } = input;

      // Security: Reject path traversal and absolute paths
      if (relativePath.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }
      if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
        throw new Error('Invalid path: must be relative');
      }
      if (destinationFolder?.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }
      if (
        destinationFolder &&
        (destinationFolder.startsWith('/') || destinationFolder.startsWith('\\'))
      ) {
        throw new Error('Invalid path: must be relative');
      }

      const sourceValidation = validateRelativePath(projectPath, relativePath);
      if (!sourceValidation.valid) {
        throw new Error(sourceValidation.error);
      }
      const absoluteSource = sourceValidation.absolutePath;

      let absoluteDestinationFolder: string;
      if (destinationFolder === undefined) {
        absoluteDestinationFolder = dirname(absoluteSource);
      } else {
        const destinationValidation = validateRelativePath(projectPath, destinationFolder || '.');
        if (!destinationValidation.valid) {
          throw new Error(destinationValidation.error);
        }
        absoluteDestinationFolder = destinationValidation.absolutePath;
      }

      // Verify source exists
      try {
        await access(absoluteSource);
      } catch {
        throw new Error(`File or folder not found: ${relativePath}`);
      }

      // Validate destination folder exists and is a directory
      try {
        const destinationStat = await stat(absoluteDestinationFolder);
        if (!destinationStat.isDirectory()) {
          throw new Error('Destination is not a folder');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Destination is not a folder') {
          throw error;
        }
        throw new Error('Destination folder not found');
      }

      // Name behavior:
      // - same-folder duplicate keeps VS Code style ("name copy", then numbered variants)
      // - cross-folder duplicate preserves original name unless already taken
      const sourceBase = basename(absoluteSource);
      const sourceDir = dirname(absoluteSource);
      const ext = extname(sourceBase);
      const nameWithoutExt = ext ? sourceBase.slice(0, -ext.length) : sourceBase;

      let copyName = sourceBase;
      const shouldPreserveOriginalName = absoluteDestinationFolder !== sourceDir;
      let mustUseCopySuffix = !shouldPreserveOriginalName;

      if (shouldPreserveOriginalName) {
        const sameNameCandidatePath = join(absoluteDestinationFolder, sourceBase);
        try {
          await access(sameNameCandidatePath);
          mustUseCopySuffix = true;
        } catch {
          copyName = sourceBase;
        }
      }

      if (mustUseCopySuffix) {
        const MAX_COPY_ATTEMPTS = 1000;
        let copyNum = 0;
        // Find an available copy-suffixed name
        while (copyNum <= MAX_COPY_ATTEMPTS) {
          const suffix = copyNum === 0 ? ' copy' : ` copy ${copyNum}`;
          copyName = ext ? `${nameWithoutExt}${suffix}${ext}` : `${nameWithoutExt}${suffix}`;
          const candidatePath = join(absoluteDestinationFolder, copyName);
          try {
            await access(candidatePath);
            // Exists, try next number
            copyNum++;
          } catch {
            // Doesn't exist — use this name
            break;
          }
        }

        if (copyNum > MAX_COPY_ATTEMPTS) {
          throw new Error(
            `Failed to generate duplicate name after ${MAX_COPY_ATTEMPTS} attempts in destination folder`,
          );
        }
      }

      const absoluteDest = join(absoluteDestinationFolder, copyName);

      // Copy the file or folder
      try {
        await cp(absoluteSource, absoluteDest, { recursive: true });
      } catch (_error) {
        throw new Error('Failed to duplicate file. Please check permissions and try again.');
      }

      // Invalidate caches
      invalidateFileListCache(projectPath);
      invalidateGitStatusCache(projectPath);

      const newRelativePath = relative(projectPath, absoluteDest);
      return { success: true, newPath: newRelativePath };
    }),

  /**
   * Write pasted text to a file in the session's pasted directory
   * Used for large text pastes that shouldn't be embedded inline
   */
  writePastedText: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        text: z.string(),
        filename: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { subChatId, text, filename } = input;

      // Security: Validate inputs don't contain path traversal
      if (subChatId.includes('..') || subChatId.includes('/') || subChatId.includes('\\')) {
        throw new Error('Invalid subChatId');
      }
      if (
        filename &&
        (filename.includes('..') || filename.includes('/') || filename.includes('\\'))
      ) {
        throw new Error('Invalid filename');
      }

      // Create pasted directory in session folder
      const sessionDir = join(app.getPath('userData'), 'claude-sessions', subChatId);
      const pastedDir = join(sessionDir, 'pasted');
      await mkdir(pastedDir, { recursive: true });

      // Generate filename with timestamp
      const finalFilename = filename || `pasted_${Date.now()}.txt`;
      const filePath = join(pastedDir, finalFilename);

      // Write file
      await writeFile(filePath, text, 'utf-8');

      return {
        filePath,
        filename: finalFilename,
        size: text.length,
      };
    }),

  /**
   * Read the project's tsconfig.json and resolve paths/baseUrl for Monaco.
   * Walks the `extends` chain and returns fully-resolved absolute paths.
   */
  getTsConfigPaths: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }) => {
      const { resolveTsConfigPaths } = await import('../../tsconfig-resolver');
      return resolveTsConfigPaths(input.projectPath);
    }),

  /**
   * Resolve a symbol or module specifier to an absolute file path.
   * Uses TypeScript's own parser + module resolution — universal, no regex.
   */
  resolveDefinition: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        containingFile: z.string(),
        symbolName: z.string().optional(),
        fileContent: z.string().optional(),
        specifier: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      // Ensure containingFile is within project (normalize to prevent e.g. /project/../outside)
      const normalizedProject = resolve(
        input.projectPath.endsWith('/') ? input.projectPath.slice(0, -1) : input.projectPath,
      );
      const normalizedContaining = resolve(input.containingFile);
      if (
        normalizedContaining !== normalizedProject &&
        !normalizedContaining.startsWith(normalizedProject + sep)
      ) {
        return null;
      }

      const { findModuleSpecifierForSymbol, resolveModuleSpecifier } =
        await import('../../module-resolver');

      let specifier = input.specifier;

      if (!specifier && input.symbolName && input.fileContent) {
        specifier = findModuleSpecifierForSymbol(input.fileContent, input.symbolName) ?? undefined;
      }

      if (!specifier) return null;

      return resolveModuleSpecifier(input.projectPath, input.containingFile, specifier);
    }),

  /**
   * Get TypeScript/JavaScript files from a project for Monaco type loading
   * Returns file contents keyed by their path for addExtraLib
   */
  getProjectTypeFiles: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        maxFiles: z.number().optional().default(500),
        maxFileSize: z.number().optional().default(100000), // 100KB max per file
      }),
    )
    .query(async ({ input }) => {
      const { projectPath, maxFiles, maxFileSize } = input;

      const files: Array<{ path: string; content: string }> = [];
      const tsExtensions = new Set(['.ts', '.tsx', '.d.ts']);
      // Skip directories that are likely nested projects (have their own package.json)
      const nestedProjectDirs = new Set<string>();

      // Check for nested projects first
      try {
        const topEntries = await readdir(projectPath, { withFileTypes: true });
        for (const entry of topEntries) {
          if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
            const nestedPkgJson = join(projectPath, entry.name, 'package.json');
            if (existsSync(nestedPkgJson)) {
              nestedProjectDirs.add(entry.name);
            }
          }
        }
      } catch {
        // Ignore errors checking for nested projects
      }

      async function scanDir(dir: string): Promise<void> {
        if (files.length >= maxFiles) return;

        try {
          const entries = await readdir(dir, { withFileTypes: true });

          for (const entry of entries) {
            if (files.length >= maxFiles) break;

            const fullPath = join(dir, entry.name);
            const relativePath = relative(projectPath, fullPath);

            if (entry.isDirectory()) {
              // Skip ignored directories
              if (IGNORED_DIRS.has(entry.name)) continue;
              // Skip nested project directories (they have their own package.json)
              if (dir === projectPath && nestedProjectDirs.has(entry.name)) continue;
              await scanDir(fullPath);
            } else if (entry.isFile()) {
              // Check if it's a TypeScript file
              const ext = entry.name.slice(entry.name.lastIndexOf('.'));
              if (!tsExtensions.has(ext)) continue;

              try {
                const stats = await stat(fullPath);
                if (stats.size > maxFileSize) continue;

                const content = await readFile(fullPath, 'utf-8');
                files.push({
                  path: relativePath,
                  content,
                });
              } catch {
                // Skip files we can't read
              }
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }

      await scanDir(projectPath);

      return { files, truncated: files.length >= maxFiles };
    }),

  /**
   * Copy a file or folder from one project to another.
   * Used by split-pane cross-project operations.
   */
  crossProjectCopy: publicProcedure
    .input(
      z.object({
        sourceProjectPath: z.string(),
        sourcePath: z.string(),
        destProjectPath: z.string(),
        destFolder: z.string().default(''),
        overwrite: z.boolean().optional().default(false),
        keepBoth: z.boolean().optional().default(false),
        operationId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { absoluteSource, absoluteDest, destProjectPath } =
        await resolveCrossProjectPaths(input);

      if (input.operationId) {
        const controller = new AbortController();
        activeOperations.set(input.operationId, {
          controller,
          ownerWebContentsId: ctx.senderWebContentsId,
          timestamp: Date.now(),
        });
        try {
          await copyWithProgress(absoluteSource, absoluteDest, {
            operationId: input.operationId,
            targetWebContentsId: ctx.senderWebContentsId,
            signal: controller.signal,
          });
        } finally {
          activeOperations.delete(input.operationId);
        }
      } else {
        await cp(absoluteSource, absoluteDest, { recursive: true });
      }

      // Invalidate caches for destination project
      invalidateFileListCache(input.destProjectPath);
      invalidateGitStatusCache(input.destProjectPath);

      return { success: true as const, destPath: relative(destProjectPath, absoluteDest) };
    }),

  /**
   * Move a file or folder from one project to another.
   * Used by split-pane cross-project operations.
   */
  crossProjectMove: publicProcedure
    .input(
      z.object({
        sourceProjectPath: z.string(),
        sourcePath: z.string(),
        destProjectPath: z.string(),
        destFolder: z.string().default(''),
        overwrite: z.boolean().optional().default(false),
        keepBoth: z.boolean().optional().default(false),
        operationId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { absoluteSource, absoluteDest, destProjectPath } =
        await resolveCrossProjectPaths(input);

      // Move (rename across volumes may fail, so copy+delete as fallback)
      try {
        await rename(absoluteSource, absoluteDest);
      } catch {
        // Cross-device rename: copy then delete using progress-aware copy
        if (input.operationId) {
          const controller = new AbortController();
          activeOperations.set(input.operationId, {
            controller,
            ownerWebContentsId: ctx.senderWebContentsId,
            timestamp: Date.now(),
          });
          try {
            await copyWithProgress(absoluteSource, absoluteDest, {
              operationId: input.operationId,
              targetWebContentsId: ctx.senderWebContentsId,
              signal: controller.signal,
            });
          } finally {
            activeOperations.delete(input.operationId);
          }
        } else {
          await cp(absoluteSource, absoluteDest, { recursive: true });
        }
        await rm(absoluteSource, { recursive: true, force: true });
      }

      // Invalidate caches for both projects
      invalidateFileListCache(input.sourceProjectPath);
      invalidateFileListCache(input.destProjectPath);
      invalidateGitStatusCache(input.sourceProjectPath);
      invalidateGitStatusCache(input.destProjectPath);

      return { success: true as const, destPath: relative(destProjectPath, absoluteDest) };
    }),

  /**
   * Cancel an in-progress cross-project copy/move operation.
   */
  crossProjectCancelOperation: publicProcedure
    .input(z.object({ operationId: z.string() }))
    .mutation(({ input, ctx }) => {
      const op = activeOperations.get(input.operationId);
      if (!op) return { cancelled: false };

      // Only the window that started the operation can cancel it
      if (op.ownerWebContentsId && ctx.senderWebContentsId !== op.ownerWebContentsId) {
        throw new Error('Access denied: only the initiating window can cancel this operation');
      }

      op.controller.abort();
      activeOperations.delete(input.operationId);
      return { cancelled: true };
    }),

  /**
   * Batch copy multiple files/folders from one project to another.
   * First pass detects conflicts; second pass (with resolutions) resolves them.
   */
  batchCrossProjectCopy: publicProcedure
    .input(
      z.object({
        sourceProjectPath: z.string(),
        sourcePaths: z.array(z.string()).min(1).max(200),
        destProjectPath: z.string(),
        destFolder: z.string().default(''),
        /** Per-item conflict resolution: key = relative source path */
        resolutions: z.record(z.string(), z.enum(['overwrite', 'keepBoth', 'skip'])).optional(),
        operationId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { sourceProjectPath, sourcePaths, destProjectPath, destFolder, resolutions } = input;

      if (destFolder.includes('..') || sourcePaths.some((p) => p.includes('..'))) {
        throw new Error('Invalid path: traversal not allowed');
      }

      const completed: string[] = [];
      const conflicts: Array<{ path: string; name: string }> = [];
      const errors: Array<{ path: string; error: string }> = [];

      // Set up cancellation and timeout for the whole batch
      const controller = input.operationId ? new AbortController() : undefined;
      const batchTimeout = setTimeout(() => controller?.abort(), BATCH_TIMEOUT_MS);

      if (input.operationId && controller) {
        activeOperations.set(input.operationId, {
          controller,
          ownerWebContentsId: ctx.senderWebContentsId,
          timestamp: Date.now(),
        });
      }

      let totalProcessed = 0;

      try {
        for (const sourcePath of sourcePaths) {
          // Check cancellation/timeout between items
          if (controller?.signal.aborted) {
            errors.push({ path: sourcePath, error: 'Operation cancelled' });
            continue;
          }

          const resolution = resolutions?.[sourcePath];

          if (resolution === 'skip') {
            continue;
          }

          try {
            const resolved = await resolveCrossProjectPaths({
              sourceProjectPath,
              sourcePath,
              destProjectPath,
              destFolder,
              overwrite: resolution === 'overwrite',
              keepBoth: resolution === 'keepBoth',
            });

            // Use copyWithProgress for timeout + cancellation support
            if (input.operationId && controller) {
              await copyWithProgress(resolved.absoluteSource, resolved.absoluteDest, {
                operationId: input.operationId,
                targetWebContentsId: ctx.senderWebContentsId,
                signal: controller.signal,
              });
            } else {
              await cp(resolved.absoluteSource, resolved.absoluteDest, { recursive: true });
            }

            completed.push(sourcePath);
            totalProcessed++;

            if (input.operationId && ctx.senderWebContentsId) {
              sendProgress(
                {
                  operationId: input.operationId,
                  current: totalProcessed,
                  total: sourcePaths.length,
                  currentFile: sourcePath,
                  done: false,
                },
                ctx.senderWebContentsId,
              );
            }
          } catch (err) {
            const message = sanitizeFileError(err);
            if (message.includes('already exists at destination') && !resolution) {
              const name = sourcePath.split('/').pop() ?? sourcePath;
              conflicts.push({ path: sourcePath, name });
            } else {
              errors.push({ path: sourcePath, error: message });
            }
          }
        }
      } finally {
        clearTimeout(batchTimeout);
        if (input.operationId) {
          activeOperations.delete(input.operationId);
          if (ctx.senderWebContentsId) {
            sendProgress(
              {
                operationId: input.operationId,
                current: totalProcessed,
                total: sourcePaths.length,
                currentFile: '',
                done: true,
              },
              ctx.senderWebContentsId,
            );
          }
        }
      }

      // Invalidate caches
      invalidateFileListCache(destProjectPath);
      invalidateGitStatusCache(destProjectPath);

      return { completed, conflicts, errors };
    }),

  /**
   * Batch move multiple files/folders from one project to another.
   * First pass detects conflicts; second pass (with resolutions) resolves them.
   */
  batchCrossProjectMove: publicProcedure
    .input(
      z.object({
        sourceProjectPath: z.string(),
        sourcePaths: z.array(z.string()).min(1).max(200),
        destProjectPath: z.string(),
        destFolder: z.string().default(''),
        resolutions: z.record(z.string(), z.enum(['overwrite', 'keepBoth', 'skip'])).optional(),
        operationId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { sourceProjectPath, sourcePaths, destProjectPath, destFolder, resolutions } = input;

      if (destFolder.includes('..') || sourcePaths.some((p) => p.includes('..'))) {
        throw new Error('Invalid path: traversal not allowed');
      }

      const completed: Array<{ sourcePath: string; destPath: string }> = [];
      const conflicts: Array<{ path: string; name: string }> = [];
      const errors: Array<{ path: string; error: string }> = [];

      // Set up cancellation and timeout for the whole batch
      const controller = input.operationId ? new AbortController() : undefined;
      const batchTimeout = setTimeout(() => controller?.abort(), BATCH_TIMEOUT_MS);

      if (input.operationId && controller) {
        activeOperations.set(input.operationId, {
          controller,
          ownerWebContentsId: ctx.senderWebContentsId,
          timestamp: Date.now(),
        });
      }

      let totalProcessed = 0;

      try {
        for (const sourcePath of sourcePaths) {
          // Check cancellation/timeout between items
          if (controller?.signal.aborted) {
            errors.push({ path: sourcePath, error: 'Operation cancelled' });
            continue;
          }

          const resolution = resolutions?.[sourcePath];

          if (resolution === 'skip') {
            totalProcessed++;
            continue;
          }

          try {
            const resolved = await resolveCrossProjectPaths({
              sourceProjectPath,
              sourcePath,
              destProjectPath,
              destFolder,
              overwrite: resolution === 'overwrite',
              keepBoth: resolution === 'keepBoth',
            });

            // Move (rename, fallback to copy+delete with timeout/cancel support)
            try {
              await rename(resolved.absoluteSource, resolved.absoluteDest);
            } catch {
              if (input.operationId && controller) {
                await copyWithProgress(resolved.absoluteSource, resolved.absoluteDest, {
                  operationId: input.operationId,
                  targetWebContentsId: ctx.senderWebContentsId,
                  signal: controller.signal,
                });
              } else {
                await cp(resolved.absoluteSource, resolved.absoluteDest, { recursive: true });
              }
              await rm(resolved.absoluteSource, { recursive: true, force: true });
            }

            completed.push({
              sourcePath,
              destPath: relative(destProjectPath, resolved.absoluteDest),
            });
            totalProcessed++;

            if (input.operationId && ctx.senderWebContentsId) {
              sendProgress(
                {
                  operationId: input.operationId,
                  current: totalProcessed,
                  total: sourcePaths.length,
                  currentFile: sourcePath,
                  done: false,
                },
                ctx.senderWebContentsId,
              );
            }
          } catch (err) {
            const message = sanitizeFileError(err);
            if (message.includes('already exists at destination') && !resolution) {
              const name = sourcePath.split('/').pop() ?? sourcePath;
              conflicts.push({ path: sourcePath, name });
            } else {
              errors.push({ path: sourcePath, error: message });
            }
          }
        }
      } finally {
        clearTimeout(batchTimeout);
        if (input.operationId) {
          activeOperations.delete(input.operationId);
          if (ctx.senderWebContentsId) {
            sendProgress(
              {
                operationId: input.operationId,
                current: totalProcessed,
                total: sourcePaths.length,
                currentFile: '',
                done: true,
              },
              ctx.senderWebContentsId,
            );
          }
        }
      }

      // Invalidate caches for both projects
      invalidateFileListCache(sourceProjectPath);
      invalidateFileListCache(destProjectPath);
      invalidateGitStatusCache(sourceProjectPath);
      invalidateGitStatusCache(destProjectPath);

      return { completed, conflicts, errors };
    }),

  /** Undo a move. Same-project callers pass one path as both projects — every guard holds. */
  undoFileMove: publicProcedure
    .input(
      z.object({
        /** The project the file was originally in (move it back here) */
        sourceProjectPath: z.string(),
        /** The relative path inside the original project */
        sourcePath: z.string(),
        /** The project the file was moved to */
        destProjectPath: z.string(),
        /** The relative path inside the destination project */
        destPath: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const { sourceProjectPath, sourcePath, destProjectPath, destPath } = input;

      if (sourcePath.includes('..') || destPath.includes('..')) {
        throw new Error('Invalid path: traversal not allowed');
      }

      const absoluteCurrent = join(destProjectPath, destPath);
      const absoluteOriginal = join(sourceProjectPath, sourcePath);

      if (!absoluteCurrent.startsWith(destProjectPath)) {
        throw new Error('Access denied: current path outside project');
      }
      if (!absoluteOriginal.startsWith(sourceProjectPath)) {
        throw new Error('Access denied: original path outside project');
      }

      try {
        await access(absoluteCurrent);
      } catch {
        throw new Error('Cannot undo: file no longer exists at destination');
      }

      // Ensure original parent folder exists
      const originalFolder = dirname(absoluteOriginal);
      await mkdir(originalFolder, { recursive: true });

      // Check if a different file now exists at the original location
      try {
        await access(absoluteOriginal);
        // Something exists — check if it's a different file (different inode)
        const originalStat = await stat(absoluteOriginal);
        const currentStat = await stat(absoluteCurrent);
        if (originalStat.ino !== currentStat.ino) {
          throw new Error('Cannot undo: original location now contains a different file');
        }
      } catch (e) {
        // Re-throw our custom error; ignore "file not found" (means path is clear)
        if (e instanceof Error && e.message.startsWith('Cannot undo')) throw e;
      }

      try {
        await rename(absoluteCurrent, absoluteOriginal);
      } catch {
        await cp(absoluteCurrent, absoluteOriginal, { recursive: true });
        await rm(absoluteCurrent, { recursive: true, force: true });
      }

      // Invalidate caches for both projects
      invalidateFileListCache(sourceProjectPath);
      invalidateFileListCache(destProjectPath);
      invalidateGitStatusCache(sourceProjectPath);
      invalidateGitStatusCache(destProjectPath);

      return { success: true as const };
    }),
});
