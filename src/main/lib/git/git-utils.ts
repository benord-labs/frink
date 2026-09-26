import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * Check if the error message indicates the upstream branch is missing/deleted
 */
export function isUpstreamMissingError(message: string): boolean {
  return (
    message.includes('no such ref was fetched') ||
    message.includes('no tracking information') ||
    message.includes("couldn't find remote ref")
  );
}

/**
 * Whether writing `relPath` into `projectPath` would add a COMMITTABLE repo file — i.e. `projectPath` is a
 * git work tree AND `relPath` is not gitignored. Used to surface "this adds files to your repo" before a
 * user-initiated "copy to local project" (a note, never a gate — `provider-config-canonical-home`).
 * Fail-open `false`: not a repo / any git error → treat as machine-local, no warning.
 */
export async function isPathCommittable(projectPath: string, relPath: string): Promise<boolean> {
  let git: ReturnType<typeof simpleGit>;
  try {
    git = simpleGit(projectPath);
    if ((await git.raw(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return false;
  } catch {
    return false; // not a git repository
  }
  // `git check-ignore` prints the path + exits 0 when IGNORED; exits non-zero (throws) when NOT ignored.
  try {
    return (await git.raw(['check-ignore', '--', relPath])).trim() === '';
  } catch {
    return true; // in a repo + not ignored → committable
  }
}

/** Whether any of the absolute `dirs` is a committable (non-gitignored) path inside `projectPath` — drives
 * the "added to your repo" note after a user-initiated copy. Shared by the skills + agents copy routers. */
export async function anyCommittableDir(projectPath: string, dirs: string[]): Promise<boolean> {
  for (const dir of dirs) {
    if (await isPathCommittable(projectPath, path.relative(projectPath, dir))) return true;
  }
  return false;
}
