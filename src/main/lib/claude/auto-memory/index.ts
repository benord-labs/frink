import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { frinkUserHome } from '../../platform/frink-home';

/** Longest Claude project folder name before the CLI cuts it and appends a hash. */
const MAX_PROJECT_DIR_NAME = 200;

/** Flag-tier settings that give a chat's CLI the project's shared auto-memory. */
type AutoMemorySettings = { autoMemoryDirectory: string; autoMemoryEnabled?: false };

/** The bundled CLI's (2.1.289) `~/.claude/projects/<name>` for a root: non-alphanumerics become `-`;
 * past 200 chars it is cut and suffixed with the root's int32 string hash. Re-verify on a CLI bump. */
export function claudeProjectDirName(projectRoot: string): string {
  const name = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_PROJECT_DIR_NAME) return name;
  let hash = 0;
  for (let i = 0; i < projectRoot.length; i++) {
    hash = ((hash << 5) - hash + projectRoot.charCodeAt(i)) | 0;
  }
  return `${name.slice(0, MAX_PROJECT_DIR_NAME)}-${Math.abs(hash).toString(36)}`;
}

function isDirOrFile(entry: string): boolean {
  try {
    const stat = fs.statSync(entry);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function isRegularFile(entry: string): boolean {
  try {
    return fs.lstatSync(entry).isFile();
  } catch {
    return false;
  }
}

/** Nearest ancestor of `dir` (inclusive) holding a `.git` directory or file. */
function findGitRoot(dir: string): string | null {
  for (let current = dir; ; current = path.dirname(current)) {
    if (isDirOrFile(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return null;
  }
}

/** A linked worktree's main checkout (or bare repo) when `root/.git` is a verified `gitdir:`
 * pointer, else `root`. A submodule's pointer has no `commondir`, so it keeps its own root. */
function mainCheckout(root: string): string {
  try {
    const pointer = fs.readFileSync(path.join(root, '.git'), 'utf-8').trim();
    if (!pointer.startsWith('gitdir:')) return root;
    const gitDir = path.resolve(root, pointer.slice('gitdir:'.length).trim());
    const commonDirFile = path.join(gitDir, 'commondir');
    const backPointerFile = path.join(gitDir, 'gitdir');
    if (!isRegularFile(commonDirFile) || !isRegularFile(backPointerFile)) return root;
    const commonDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf-8').trim());
    if (path.dirname(gitDir) !== path.join(commonDir, 'worktrees')) return root;
    const backPointer = path.resolve(gitDir, fs.readFileSync(backPointerFile, 'utf-8').trim());
    const rootGit = path.join(fs.realpathSync.native(root), '.git');
    if (fs.realpathSync.native(backPointer) !== rootGit) return root;
    if (path.basename(commonDir) === '.git') return path.dirname(commonDir).normalize('NFC');
    return isDirOrFile(path.join(commonDir, '.git')) ? root : commonDir.normalize('NFC');
  } catch {
    // `.git` is a directory, or the pointer chain is unreadable: the walk's root stands.
    return root;
  }
}

/** The root the CLI keys auto-memory by: the physical `cwd`'s git root, a linked worktree mapped to
 * its main checkout; a `cwd` outside any repo (a general chat in home) keys itself. */
export function claudeMemoryProjectRoot(cwd: string): string {
  let physical: string;
  try {
    physical = fs.realpathSync.native(cwd).normalize('NFC');
  } catch {
    physical = path.resolve(cwd).normalize('NFC');
  }
  const root = findGitRoot(physical);
  return root ? mainCheckout(root) : physical;
}

/** The user's auto-memory keys in `~/.claude/settings.json`; a mistyped key is dropped, not fatal. */
const UserMemorySettings = z.object({
  autoMemoryDirectory: z.string().optional().catch(undefined),
  autoMemoryEnabled: z.boolean().optional().catch(undefined),
});
type UserMemorySettings = z.infer<typeof UserMemorySettings>;

/** The user's own auto-memory settings, which a chat's isolated config dir hides from the CLI. */
function readUserMemorySettings(home: string): UserMemorySettings {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8');
    return UserMemorySettings.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** The CLI accepts only an absolute or `~/` directory; `~` is expanded here so FRINK_HOME holds. */
function userMemoryDirectory(directory: string | undefined, home: string): string | null {
  if (!directory) return null;
  if (directory.startsWith('~/')) return path.join(home, directory.slice(2));
  return path.isAbsolute(directory) ? directory : null;
}

/** Point a chat's CLI at the auto-memory folder Claude Code uses for its project outside Frink, shared
 * by every chat, worktree and terminal session. The user's own folder and off switch win. */
export function resolveClaudeAutoMemorySettings(cwd: string): AutoMemorySettings {
  const home = frinkUserHome();
  const user = readUserMemorySettings(home);
  const autoMemoryDirectory =
    userMemoryDirectory(user.autoMemoryDirectory, home) ??
    path.join(
      home,
      '.claude',
      'projects',
      claudeProjectDirName(claudeMemoryProjectRoot(cwd)),
      'memory',
    );
  if (user.autoMemoryEnabled === false) return { autoMemoryDirectory, autoMemoryEnabled: false };
  return { autoMemoryDirectory };
}
