import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { resolveProviderFromHost } from '../../../shared/lib/git-url';
import type { getDatabase } from '../db';
import { createOrGetProjectByPath, getProjectByPath, updateProject } from '../db/repos/projects';
import type { Project } from '../db/schema';
import type { GitRemoteInfo } from '../git';

/** What creating a project from a path touches; the router passes the live implementations. */
export type ProjectCreationDeps = {
  getDb: () => ReturnType<typeof getDatabase>;
  getGitRemoteInfo: (path: string) => Promise<GitRemoteInfo>;
  trackProjectOpened: (project: { id: string; hasGitRemote: boolean }) => void;
};

export type GitHubCloneDeps = ProjectCreationDeps & {
  homeDir: () => string;
  spawnGit: (args: string[]) => Promise<void>;
};

/** Spawn git with array arguments (no shell), rejecting with stderr on a non-zero exit. */
export function spawnGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args);
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git command failed: ${stderr || `exit code ${code}`}`));
    });
  });
}

const gitColumns = (gitInfo: GitRemoteInfo) => ({
  gitRemoteUrl: gitInfo.normalizedUrl,
  gitProvider: gitInfo.provider,
  gitOwner: gitInfo.owner,
  gitRepo: gitInfo.repo,
});

/** Insert-or-adopt the project for `path`; a concurrent same-path caller gets the winner's row. */
async function registerAtPath(
  deps: ProjectCreationDeps,
  name: string,
  path: string,
): Promise<Project> {
  const gitInfo = await deps.getGitRemoteInfo(path);
  const { project } = await createOrGetProjectByPath(deps.getDb(), {
    name,
    path,
    ...gitColumns(gitInfo),
  });
  deps.trackProjectOpened({ id: project.id, hasGitRemote: !!gitInfo.remoteUrl });
  return project;
}

/** Open a picked folder: refresh an existing project's git remote, else create (or adopt) one. */
export async function openProjectAtPath(deps: ProjectCreationDeps, path: string): Promise<Project> {
  const gitInfo = await deps.getGitRemoteInfo(path);
  const db = deps.getDb();
  const existing = await getProjectByPath(db, path);
  const project = existing
    ? ((await updateProject(db, existing.id, gitColumns(gitInfo))) ?? existing)
    : (await createOrGetProjectByPath(db, { name: basename(path), path, ...gitColumns(gitInfo) }))
        .project;
  deps.trackProjectOpened({ id: project.id, hasGitRemote: !!gitInfo.remoteUrl });
  return project;
}

/** The existing project for `path`, else a new one named `name` (or the folder name). */
export async function createProjectAtPath(
  deps: ProjectCreationDeps,
  path: string,
  name?: string,
): Promise<Project> {
  const existing = await getProjectByPath(deps.getDb(), path);
  return existing ?? registerAtPath(deps, name || basename(path), path);
}

const GIT_SUFFIX_REGEX = /\.git$/;
const SCHEME_URL_REGEX = /^(https?|ssh):\/\//i;
const SCP_SSH_REGEX = /^git@([^:/]+):(.+)$/i;
const GITHUB_OWNER_REGEX = /^[A-Za-z0-9-]+$/;
const GITHUB_REPO_REGEX = /^[A-Za-z0-9._-]+$/;
const DOTS_ONLY_REGEX = /^\.+$/;
const LANDED_CODES = new Set(['ENOTEMPTY', 'EEXIST']);

/** Owner and repo as found in a URL, before name validation. */
type RepoUrlParts = { owner?: string; repo?: string; sshPrefix?: string };

/** A validated GitHub repo. Over ssh, `sshPrefix` keeps the remote's own form (alias, user,
 * port), e.g. `git@github.com-work:` or `ssh://git@github.com:2222/`. */
export type GitHubRepoRef = { owner: string; repo: string; sshPrefix?: string };

/** GitHub, including `www.` and ssh aliases like github.com-work; hostnames are case-insensitive. */
const isGitHubHost = (host: string) =>
  resolveProviderFromHost(host.toLowerCase().replace(/^www\./, ''))?.provider === 'github';

/** The first two path segments are owner/repo; trailing slashes and `/tree/...` are ignored. */
function ownerRepoFromPath(path: string): RepoUrlParts {
  const [owner, repo] = path.split('/').filter(Boolean);
  return { owner, repo };
}

function matchSchemeUrl(input: string): RepoUrlParts {
  const url = URL.canParse(input) ? new URL(input) : null;
  if (!url || !isGitHubHost(url.hostname)) return {};
  return { ...ownerRepoFromPath(url.pathname), sshPrefix: sshSchemePrefix(url) };
}

/** `ssh://user@host[:port]/` for an ssh URL; `ssh:` is not a special scheme, so lowercase the host. */
function sshSchemePrefix(url: URL): string | undefined {
  if (url.protocol !== 'ssh:') return undefined;
  const port = url.port ? `:${url.port}` : '';
  return `ssh://${url.username || 'git'}@${url.hostname.toLowerCase()}${port}/`;
}

function matchScpUrl(host: string, path: string): RepoUrlParts {
  if (!isGitHubHost(host)) return {};
  return { ...ownerRepoFromPath(path), sshPrefix: `git@${host.toLowerCase()}:` };
}

function matchShorthand(input: string): RepoUrlParts {
  return input.split('/').filter(Boolean).length === 2 ? ownerRepoFromPath(input) : {};
}

/** Scheme URLs (https/http/ssh), scp-style `git@host:owner/repo`, or `owner/repo` shorthand. */
function matchRepoUrl(input: string): RepoUrlParts {
  if (SCHEME_URL_REGEX.test(input)) return matchSchemeUrl(input);
  const scp = input.match(SCP_SSH_REGEX);
  return scp ? matchScpUrl(scp[1] ?? '', scp[2] ?? '') : matchShorthand(input);
}

/** GitHub's own name charsets: no separators and never `.`/`..`, so the path stays in repos/. */
function isGitHubName(owner: string, repo: string): boolean {
  return (
    GITHUB_OWNER_REGEX.test(owner) && GITHUB_REPO_REGEX.test(repo) && !DOTS_ONLY_REGEX.test(repo)
  );
}

export function parseGitHubRepo(repoUrl: string): GitHubRepoRef | null {
  const { owner, repo, sshPrefix } = matchRepoUrl(repoUrl.trim());
  const name = repo?.replace(GIT_SUFFIX_REGEX, '');
  return owner && name && isGitHubName(owner, name) ? { owner, repo: name, sshPrefix } : null;
}

/** Clone into a private sibling, then rename into place: clonePath only ever holds a finished
 * repo, and a failed clone removes only the directory this call created. */
async function cloneIntoPlace(
  deps: GitHubCloneDeps,
  cloneUrl: string,
  reposDir: string,
  clonePath: string,
): Promise<void> {
  await mkdir(reposDir, { recursive: true });
  // mkdtemp makes a unique empty folder (git clones into an empty one), never shared with another attempt.
  const staging = await mkdtemp(join(reposDir, `.${basename(clonePath)}.cloning-`));
  try {
    await deps.spawnGit(['clone', cloneUrl, staging]);
    await rename(staging, clonePath);
  } catch (err) {
    // Renames are atomic, so a non-empty destination is another process's finished clone: keep it.
    const landed = err instanceof Error && 'code' in err && LANDED_CODES.has(String(err.code));
    if (!landed) throw err;
  } finally {
    // Gone after a successful rename; otherwise this call's own partial or redundant checkout.
    await rm(staging, { recursive: true, force: true });
  }
}

/** Entries of `dir`, or none when it does not exist yet. */
async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
}

/** The real on-disk entry of `dir` matching `name` in any casing, preferring the lowercase one:
 * finds clones made before paths were lowercased, on case-sensitive filesystems too. */
async function findEntryIgnoringCase(dir: string, name: string): Promise<string | null> {
  const wanted = name.toLowerCase();
  const matches = (await listEntries(dir)).filter((e) => e.toLowerCase() === wanted);
  const entry = matches.includes(wanted) ? wanted : matches[0];
  return entry ? join(dir, entry) : null;
}

async function findExistingClone(
  reposRoot: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  const ownerDir = await findEntryIgnoringCase(reposRoot, owner);
  return ownerDir ? findEntryIgnoringCase(ownerDir, repo) : null;
}

/** Where one GitHub repo lives locally and how to fetch it. */
type CloneTarget = {
  owner: string;
  repo: string;
  reposRoot: string;
  reposDir: string;
  clonePath: string;
  cloneUrl: string;
};

/** Reuse an existing clone (registering it if it has no project yet), else clone it fresh. */
async function reuseOrClone(deps: GitHubCloneDeps, target: CloneTarget): Promise<Project> {
  const onDisk = await findExistingClone(target.reposRoot, target.owner, target.repo);
  if (!onDisk) {
    await cloneIntoPlace(deps, target.cloneUrl, target.reposDir, target.clonePath);
    return registerAtPath(deps, target.repo, target.clonePath);
  }
  const existing = await getProjectByPath(deps.getDb(), onDisk);
  if (!existing) return registerAtPath(deps, target.repo, onDisk);
  deps.trackProjectOpened({ id: existing.id, hasGitRemote: !!existing.gitRemoteUrl });
  return existing;
}

/** Clone-or-reuse a GitHub repo under `<home>/.frink/repos` and return its project. Concurrent
 * calls for one repo share one attempt, keyed by its canonical lowercase destination. */
export function createGitHubCloner(deps: GitHubCloneDeps) {
  const inFlight = new Map<string, Promise<Project>>();

  return async function cloneGitHubRepo(repoUrl: string): Promise<Project> {
    const parsed = parseGitHubRepo(repoUrl);
    if (!parsed) throw new Error('Invalid GitHub URL or repo format');
    const { owner, repo, sshPrefix } = parsed;
    // GitHub names are case-insensitive: one canonical lowercase destination per repo.
    const reposRoot = join(deps.homeDir(), '.frink', 'repos');
    const reposDir = join(reposRoot, owner.toLowerCase());
    const clonePath = join(reposDir, repo.toLowerCase());

    const pending = inFlight.get(clonePath);
    if (pending) return pending;

    // Keep the ssh remote's form: an alias or port can carry what this clone needs (~/.ssh/config).
    const cloneUrl = `${sshPrefix ?? 'https://github.com/'}${owner}/${repo}.git`;
    const target = { owner, repo, reposRoot, reposDir, clonePath, cloneUrl };
    // The body starts on a microtask, so the map entry is published before any filesystem work.
    const work = Promise.resolve().then(() => reuseOrClone(deps, target));
    inFlight.set(clonePath, work);
    try {
      return await work;
    } finally {
      inFlight.delete(clonePath);
    }
  };
}
