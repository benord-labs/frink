/**
 * Atomic install helpers for the bundled-binary build scripts.
 *
 * macOS caches a signed Mach-O's code signature per vnode. Rewriting an executable in place
 * (truncate + write, or copyFile onto it) leaves the kernel holding the old signature for the new
 * bytes, and every later exec is SIGKILLed. So a binary is only ever replaced by renaming a fully
 * written, verified sibling over it — a new inode, and a failed run leaves the old file intact.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const stagingPrefix = (name) => `.${name}.staging-`;

/**
 * A unique staging path in `dir` for a file that will be installed as `name`. Keeps `name`'s
 * extension so a staged `.exe` can still be executed for verification on Windows.
 */
export function stagingPath(dir, name) {
  const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(dir, `${stagingPrefix(name)}${suffix}${path.extname(name)}`);
}

/** Whether `pid` is a running process (EPERM: it exists but belongs to another user). */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Remove staging files for `name` left in `dir` by an interrupted run. Worktrees share one
 * resources/bin through a symlink, so a file whose owning pid is still alive belongs to a
 * concurrent download and is left alone.
 */
export function sweepStaging(dir, name) {
  if (!fs.existsSync(dir)) return;
  const prefix = stagingPrefix(name);
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length).split('-')[0]);
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) continue;
    fs.rmSync(path.join(dir, entry), { force: true });
  }
}

/**
 * Rename `stagedPath` over `targetPath` (atomic, new inode). The staged file is removed on any
 * failure so it never lingers next to the binary.
 */
export function installStaged(stagedPath, targetPath, { mode } = {}) {
  try {
    if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(stagedPath, mode);
    fs.renameSync(stagedPath, targetPath);
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EBUSY')) {
      throw new Error(
        `Cannot replace ${targetPath}: it is in use. Quit anything running it and retry.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Write `contents` to `targetPath` via a sibling staging file + rename. */
export function writeFileAtomic(targetPath, contents) {
  const staged = stagingPath(path.dirname(targetPath), path.basename(targetPath));
  fs.writeFileSync(staged, contents);
  installStaged(staged, targetPath);
}
