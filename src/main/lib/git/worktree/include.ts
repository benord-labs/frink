import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import ignore, { type Ignore } from 'ignore';
import picomatch from 'picomatch';
import { isSystemDeniedPath } from '../../permissions/v2/system-denied-patterns';
import { getGitEnv } from '../shell-env';
import { runGitCheckIgnore } from '../watcher/ignored-paths';
import { isPathInside } from './hooks';

const execFileAsync = promisify(execFile);

/** Cross-tool convention (Claude Code, Orca, Cline): gitignore-syntax list of ignored files to carry over. */
const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** Local git config key: a personal, never-committed off switch for the copy, per repository. */
const COPY_SETTING_KEY = 'frink.copyIgnoredFiles';

const MAX_INCLUDE_FILE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Committed templates hold no secrets and are usually tracked; never part of the default. */
const ENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template']);

type WorktreeIncludeSkip = { path: string; reason: 'too-large' | 'symlink' };

export type WorktreeIncludePlan = {
  source: 'worktreeinclude' | 'default';
  /** Repo-root-relative, `/`-separated, sorted. */
  files: string[];
  skipped: WorktreeIncludeSkip[];
  /** Matching files left out once the file-count or total-size cap was reached. */
  overLimit: number;
  /** Null when the project isn't a readable git repo. */
  repoRoot: string | null;
  /** False when the user switched copying off for this repository. */
  enabled: boolean;
};

export type WorktreeIncludeCopyResult = {
  copied: number;
  alreadyPresent: number;
  failed: number;
  /** Left out because the new worktree's own ignore rules don't cover them. */
  notIgnored: number;
};

function exitedWith(error: Error, code: number): boolean {
  return 'code' in error && error.code === code;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: await getGitEnv(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

/** Ignored untracked entries; with `collapse`, a wholly ignored directory is one `dir/` entry. */
async function listIgnored(repoRoot: string, collapse: boolean, under?: string): Promise<string[]> {
  const args = ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'];
  if (collapse) args.push('--directory');
  if (under) args.push('--', under);
  return (await git(repoRoot, args)).split('\0').filter(Boolean);
}

async function readIncludeFile(repoRoot: string): Promise<string | null> {
  const includePath = join(repoRoot, WORKTREE_INCLUDE_FILE);
  try {
    const stats = await lstat(includePath);
    if (!stats.isFile() || stats.size > MAX_INCLUDE_FILE_BYTES) return null;
    return await readFile(includePath, 'utf8');
  } catch {
    return null;
  }
}

/** Positive patterns that spell out a path from the root, split into segments. */
function pathPatterns(content: string): string[][] {
  const patterns: string[][] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const pattern = line.replace(/^\//, '').replace(/\/$/, '');
    if (!pattern.includes('/') || pattern.startsWith('**')) continue;
    patterns.push(pattern.split('/'));
  }
  return patterns;
}

/** Whether a file inside the collapsed directory `dir/` could match the pattern's segments. */
function reachesInto(pattern: string[], dir: string): boolean {
  const segments = dir.split('/').filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    if (pattern[index] === '**') return true;
    // The pattern's last segment names a file, so a directory at that depth or deeper can't match.
    if (index >= pattern.length - 1) return false;
    if (!picomatch.isMatch(segment, pattern[index], { dot: true })) return false;
  }
  return true;
}

// A collapsed ignored directory (node_modules is one entry) is opened only when it matches or a
// pattern spelling out a path can reach inside it, never for an unanchored `**` pattern.
async function matchIncludeFile(
  repoRoot: string,
  entries: string[],
  content: string,
): Promise<string[]> {
  const ig: Ignore = ignore().add(content);
  const patterns = pathPatterns(content);
  const matched: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('/')) {
      if (ig.ignores(entry)) matched.push(entry);
      continue;
    }
    const opens = ig.ignores(entry) || patterns.some((pattern) => reachesInto(pattern, entry));
    if (!opens) continue;
    const inside = await listIgnored(repoRoot, false, entry);
    matched.push(...inside.filter((file) => ig.ignores(file)));
  }
  return matched;
}

/** `.env*` files only: a collapsed `.env/` entry is a Python virtualenv, never a secrets file. */
function matchDefault(entries: string[]): string[] {
  return entries.filter((entry) => {
    if (entry.endsWith('/')) return false;
    const name = basename(entry).toLowerCase();
    return name.startsWith('.env') && !ENV_TEMPLATE_NAMES.has(name);
  });
}

type Candidate = { size: number } | { skip: WorktreeIncludeSkip['reason'] } | null;

async function inspectCandidate(realRoot: string, source: string, rel: string): Promise<Candidate> {
  const link = await lstat(source);
  if (link.isSymbolicLink()) {
    // A link out of the repository would pull in a file such as ~/.ssh/id_rsa.
    if (!isPathInside(realRoot, await realpath(source))) return { skip: 'symlink' };
    // A `.env.example` linked to `.env` would land as a regular template that agents may read.
    if (basename(rel).toLowerCase() === '.env.example' && isSystemDeniedPath(source)) {
      return { skip: 'symlink' };
    }
  }
  const target = link.isSymbolicLink() ? await stat(source) : link;
  if (!target.isFile()) return null;
  return target.size > MAX_FILE_BYTES ? { skip: 'too-large' } : { size: target.size };
}

async function applyCaps(repoRoot: string, matched: string[]) {
  const files: string[] = [];
  const skipped: WorktreeIncludeSkip[] = [];
  let totalBytes = 0;
  const sorted = [...new Set(matched)].sort();
  const realRoot = await realpath(repoRoot);
  for (const [index, rel] of sorted.entries()) {
    if (files.length >= MAX_FILES) return { files, skipped, overLimit: sorted.length - index };
    const candidate = await inspectCandidate(realRoot, join(repoRoot, rel), rel).catch(() => null);
    if (!candidate) continue;
    if ('skip' in candidate) {
      skipped.push({ path: rel, reason: candidate.skip });
      continue;
    }
    if (totalBytes + candidate.size > MAX_TOTAL_BYTES) {
      return { files, skipped, overLimit: sorted.length - index };
    }
    totalBytes += candidate.size;
    files.push(rel);
  }
  return { files, skipped, overLimit: 0 };
}

/** Unset means on: the copy is the default. Exit 1 is git's "key not set". */
async function readCopySetting(repoRoot: string): Promise<boolean> {
  try {
    return (
      (await git(repoRoot, ['config', '--type=bool', '--get', COPY_SETTING_KEY])).trim() !== 'false'
    );
  } catch (error) {
    if (error instanceof Error && exitedWith(error, 1)) return true;
    throw error;
  }
}

/** Switches the copy on or off for every project in this repository. Throws if git can't write it. */
export async function setWorktreeCopyEnabled(
  mainRepoPath: string,
  enabled: boolean,
): Promise<void> {
  await git(mainRepoPath, ['config', '--local', '--type=bool', COPY_SETTING_KEY, String(enabled)]);
}

/** Ignored files a new worktree receives: `.worktreeinclude` matches, else `.env*`. Never throws. */
export async function resolveWorktreeIncludes(mainRepoPath: string): Promise<WorktreeIncludePlan> {
  let source: WorktreeIncludePlan['source'] = 'default';
  try {
    // Worktrees are whole-repo, so paths are taken from the top level even for a subfolder project.
    const repoRoot = (await git(mainRepoPath, ['rev-parse', '--show-toplevel'])).trim();
    const enabled = await readCopySetting(repoRoot);
    const content = await readIncludeFile(repoRoot);
    if (content !== null) source = 'worktreeinclude';
    const entries = await listIgnored(repoRoot, true);
    const matched =
      content === null ? matchDefault(entries) : await matchIncludeFile(repoRoot, entries, content);
    return { source, repoRoot, enabled, ...(await applyCaps(repoRoot, matched)) };
  } catch (error) {
    log.warn('[Worktree] Could not work out which ignored files to copy', {
      mainRepoPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { source, files: [], skipped: [], overLimit: 0, repoRoot: null, enabled: true };
  }
}

/**
 * The files the new worktree's own ignore rules cover. The main checkout's rules can differ (an
 * uncommitted .gitignore edit), and a file the worktree doesn't ignore is one `git add -A` commits.
 */
async function ignoredInWorktree(worktreePath: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const ignored = await runGitCheckIgnore(worktreePath, files);
  if (!ignored) {
    log.warn('[Worktree] Could not check ignore rules in the new worktree; copying nothing', {
      worktreePath,
    });
  }
  return ignored ?? new Set();
}

type CopyOutcome = 'copied' | 'alreadyPresent' | 'failed';

/**
 * Re-checked when copying, not only when planning: a file swapped for a link to ~/.ssh/id_rsa in
 * between must not be copied. The opened file must be the very file just checked to be inside.
 */
async function readInsideRepo(
  realRoot: string,
  source: string,
): Promise<{ data: Buffer; mode: number }> {
  const real = await realpath(source);
  if (!isPathInside(realRoot, real)) throw new Error('links outside the repository');
  const handle = await open(real, 'r');
  try {
    const opened = await handle.stat();
    const onDisk = await lstat(real);
    const same = opened.ino === onDisk.ino && opened.dev === onDisk.dev && onDisk.isFile();
    if (!same || opened.size > MAX_FILE_BYTES) throw new Error('changed while being copied');
    // Only the size just checked: a file growing past the cap meanwhile is cut, not read whole.
    const data = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(data, 0, opened.size, 0);
    return { data: data.subarray(0, bytesRead), mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

/** Copies, never links, so agent edits stay in the worktree; never overwrites an existing file. */
async function copyOne(realRoot: string, source: string, target: string): Promise<CopyOutcome> {
  try {
    const { data, mode } = await readInsideRepo(realRoot, source);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx', mode });
    await chmod(target, mode);
    return 'copied';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return 'alreadyPresent';
    log.warn('[Worktree] Could not copy ignored file into worktree', {
      target,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/** Copy a resolved plan's files into a freshly created worktree. Never throws. */
export async function copyPlannedFiles(
  plan: WorktreeIncludePlan,
  worktreePath: string,
): Promise<WorktreeIncludeCopyResult> {
  const result: WorktreeIncludeCopyResult = {
    copied: 0,
    alreadyPresent: 0,
    failed: 0,
    notIgnored: 0,
  };
  if (!plan.repoRoot || !plan.enabled) return result;

  const realRoot = await realpath(plan.repoRoot).catch(() => null);
  if (!realRoot) return result;
  const ignored = await ignoredInWorktree(worktreePath, plan.files);
  for (const rel of plan.files) {
    const outcome = ignored.has(rel)
      ? await copyOne(realRoot, join(plan.repoRoot, rel), join(worktreePath, rel))
      : 'notIgnored';
    result[outcome]++;
  }

  if (plan.files.length > 0 || plan.skipped.length > 0 || plan.overLimit > 0) {
    log.info('[Worktree] Copied ignored files into worktree', {
      worktreePath,
      source: plan.source,
      ...result,
      skipped: plan.skipped,
      overLimit: plan.overLimit,
    });
  }
  return result;
}

/** Copy the resolved files into a freshly created worktree. Never throws. */
export async function copyWorktreeIncludes(
  mainRepoPath: string,
  worktreePath: string,
): Promise<WorktreeIncludeCopyResult> {
  return copyPlannedFiles(await resolveWorktreeIncludes(mainRepoPath), worktreePath);
}
