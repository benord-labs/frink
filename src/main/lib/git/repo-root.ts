import fs from 'node:fs';
import path from 'node:path';

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
export function findGitRoot(dir: string): string | null {
  for (let current = dir; ; current = path.dirname(current)) {
    if (isDirOrFile(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return null;
  }
}

/** A linked worktree's main checkout (or bare repo) when `root/.git` is a verified `gitdir:`
 * pointer, else `root`. A submodule's pointer has no `commondir`, so it keeps its own root. */
export function mainCheckout(root: string): string {
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
