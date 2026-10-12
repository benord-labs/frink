/** Concurrent same-path project creation and GitHub clones: a racing caller adopts the winner's
 * row or joins the running clone instead of failing on UNIQUE(projects.path) or `git clone`. */

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import type { GitRemoteInfo } from '../git';
import {
  createGitHubCloner,
  createProjectAtPath,
  type GitHubCloneDeps,
  openProjectAtPath,
} from '.';

const NO_REMOTE: GitRemoteInfo = {
  remoteUrl: null,
  normalizedUrl: null,
  provider: null,
  owner: null,
  repo: null,
};
const WIDGET_REMOTE: GitRemoteInfo = {
  remoteUrl: 'https://github.com/acme/widget.git',
  normalizedUrl: 'github.com/acme/widget',
  provider: 'github',
  owner: 'acme',
  repo: 'widget',
};

type PendingClone = { dest: string; exit: (ok: boolean) => void };

let db: TestDb;
let home: string;
let clones: PendingClone[];
let gitInfo: (path: string) => Promise<GitRemoteInfo>;

beforeEach(() => {
  db = freshDb();
  home = mkdtempSync(join(tmpdir(), 'frink-clone-'));
  clones = [];
  gitInfo = async () => NO_REMOTE;
});

/** Like git, the fake creates its destination as soon as the clone starts. */
function fakeSpawnGit(args: string[]): Promise<void> {
  const dest = args[2] ?? '';
  mkdirSync(join(dest, '.git'), { recursive: true });
  return new Promise((resolve, reject) => {
    clones.push({
      dest,
      exit: (ok) => (ok ? resolve() : reject(new Error('git command failed: exit code 128'))),
    });
  });
}

const deps = (): GitHubCloneDeps => ({
  getDb: () => db,
  getGitRemoteInfo: (path) => gitInfo(path),
  trackProjectOpened: vi.fn(),
  homeDir: () => home,
  spawnGit: fakeSpawnGit,
});

/** Hold every git-info lookup until release(), so concurrent callers all pass the pre-check. */
function gateGitInfo(): () => void {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  gitInfo = async () => {
    await gate;
    return NO_REMOTE;
  };
  return release;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = () => new Promise((r) => setTimeout(r, 50));
const clonePathFor = (owner: string, repo: string) => join(home, '.frink', 'repos', owner, repo);
const projectRows = () => db.select().from(schema.projects);

describe('createProjectAtPath', () => {
  it('resolves two concurrent same-path creates to one row', async () => {
    const release = gateGitInfo();
    const a = createProjectAtPath(deps(), '/repos/shared');
    const b = createProjectAtPath(deps(), '/repos/shared');
    await tick();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.id).toBe(ra.id);
    expect(ra.name).toBe('shared');
    expect(await projectRows()).toHaveLength(1);
  });
});

describe('openProjectAtPath', () => {
  it('creates a project named after the folder, with its git remote', async () => {
    gitInfo = async () => WIDGET_REMOTE;
    const row = await openProjectAtPath(deps(), '/repos/widget');
    expect(row).toMatchObject({ name: 'widget', gitRemoteUrl: 'github.com/acme/widget' });
  });

  it('refreshes the git remote of a folder that is already a project', async () => {
    await db.insert(schema.projects).values({ id: 'p1', name: 'Widget', path: '/repos/widget' });
    gitInfo = async () => WIDGET_REMOTE;
    const row = await openProjectAtPath(deps(), '/repos/widget');
    expect(row).toMatchObject({ id: 'p1', name: 'Widget', gitOwner: 'acme' });
    expect(await projectRows()).toHaveLength(1);
  });

  it('resolves two panes opening the same new folder to one row', async () => {
    const release = gateGitInfo();
    const a = openProjectAtPath(deps(), '/repos/pane-folder');
    const b = openProjectAtPath(deps(), '/repos/pane-folder');
    await tick();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.id).toBe(ra.id);
    expect(await projectRows()).toHaveLength(1);
  });
});

describe('createGitHubCloner', () => {
  it('runs one clone for two concurrent requests of the same repo', async () => {
    const clone = createGitHubCloner(deps());
    const a = clone('acme/widget');
    const b = clone('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    await settle();
    expect(clones).toHaveLength(1);
    clones[0]?.exit(true);
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.id).toBe(ra.id);
    expect(await projectRows()).toHaveLength(1);
  });

  it('gives a request arriving mid-clone the finished repo with its remote', async () => {
    let cloned = false;
    gitInfo = async () => (cloned ? WIDGET_REMOTE : NO_REMOTE);
    const clone = createGitHubCloner(deps());
    const a = clone('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    const b = clone('acme/widget');
    await settle();
    cloned = true;
    clones[0]?.exit(true);
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.id).toBe(ra.id);
    expect(ra.gitRemoteUrl).toBe('github.com/acme/widget');
  });

  it('shares one clone across shorthand, https and ssh forms of a repo', async () => {
    const clone = createGitHubCloner(deps());
    const calls = [
      clone('acme/widget'),
      clone('https://github.com/acme/widget.git'),
      clone('git@github.com:acme/widget.git'),
    ];
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    await settle();
    expect(clones).toHaveLength(1);
    clones[0]?.exit(true);
    const rows = await Promise.all(calls);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
  });

  it('shares one clone across concurrent owner/repo case variants', async () => {
    const clone = createGitHubCloner(deps());
    const a = clone('Acme/Widget');
    const b = clone('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    await settle();
    expect(clones).toHaveLength(1);
    clones[0]?.exit(true);
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.id).toBe(ra.id);
  });

  it('reuses an earlier clone for a later case variant, keeping the typed display name', async () => {
    const clone = createGitHubCloner(deps());
    const first = clone('Acme/Widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    clones[0]?.exit(true);
    const a = await first;
    expect(a.path).toBe(clonePathFor('acme', 'widget'));
    expect(a.name).toBe('Widget');

    const b = await clone('acme/widget');
    expect(b.id).toBe(a.id);
    expect(clones).toHaveLength(1);
  });

  it('resolves two requests for an on-disk repo that is not yet a project to one row', async () => {
    mkdirSync(clonePathFor('acme', 'widget'), { recursive: true });
    const release = gateGitInfo();
    const clone = createGitHubCloner(deps());
    const a = clone('acme/widget');
    const b = clone('acme/widget');
    await tick();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb.id).toBe(ra.id);
    expect(clones).toHaveLength(0);
    expect(await projectRows()).toHaveLength(1);
  });

  it('rejects every joined caller when the clone fails, and a retry clones again', async () => {
    const clone = createGitHubCloner(deps());
    const a = clone('acme/widget');
    const b = clone('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    clones[0]?.exit(false);
    await expect(a).rejects.toThrow(/git command failed/);
    await expect(b).rejects.toThrow(/git command failed/);

    const retry = clone('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(2));
    clones[1]?.exit(true);
    await expect(retry).resolves.toMatchObject({ name: 'widget' });
    expect(await projectRows()).toHaveLength(1);
  });

  it('never exposes a partial clone at clonePath, and removes it when the clone dies', async () => {
    const clonePath = clonePathFor('acme', 'widget');
    const clone = createGitHubCloner(deps());
    const first = clone('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    const staging = clones[0]?.dest ?? '';
    expect(staging).not.toBe(clonePath);
    expect(existsSync(clonePath)).toBe(false);
    clones[0]?.exit(false);
    await expect(first).rejects.toThrow(/git command failed/);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(clonePath)).toBe(false);

    const retry = clone('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(2));
    clones[1]?.exit(true);
    await expect(retry).resolves.toMatchObject({ path: clonePath });
    expect(existsSync(join(clonePath, '.git'))).toBe(true);
  });

  it('adopts the clone another process finished first instead of failing its rename', async () => {
    const clonePath = clonePathFor('acme', 'widget');
    const pending = createGitHubCloner(deps())('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    const staging = clones[0]?.dest ?? '';
    mkdirSync(join(clonePath, '.git', 'objects'), { recursive: true }); // the other clone landed
    clones[0]?.exit(true);
    await expect(pending).resolves.toMatchObject({ path: clonePath });
    expect(existsSync(staging)).toBe(false);
    expect(await projectRows()).toHaveLength(1);
  });

  it('leaves a sibling folder untouched when a clone fails', async () => {
    const sibling = clonePathFor('acme', 'other');
    mkdirSync(sibling, { recursive: true });
    const first = createGitHubCloner(deps())('acme/widget');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    clones[0]?.exit(false);
    await expect(first).rejects.toThrow(/git command failed/);
    expect(existsSync(sibling)).toBe(true);
  });

  it('reuses a mixed-case legacy clone folder whatever casing is requested', async () => {
    const legacyDir = clonePathFor('Acme', 'Widget');
    mkdirSync(join(legacyDir, '.git'), { recursive: true });
    await db.insert(schema.projects).values({ id: 'legacy', name: 'Widget', path: legacyDir });
    const row = await createGitHubCloner(deps())('acme/widget');
    expect(row.id).toBe('legacy');
    expect(clones).toHaveLength(0);
    expect(await projectRows()).toHaveLength(1);
  });

  it('registers a mixed-case legacy clone folder with no project at its own path', async () => {
    const legacyDir = clonePathFor('Acme', 'Widget');
    mkdirSync(join(legacyDir, '.git'), { recursive: true });
    const row = await createGitHubCloner(deps())('acme/widget');
    expect(row.path).toBe(legacyDir);
    expect(clones).toHaveLength(0);
  });

  it.each([
    'https://gitlab.com/acme/widget',
    'https://bitbucket.org/acme/widget.git',
    'git@gitlab.com:acme/widget.git',
    'git@github.com.evil.tld:acme/widget.git',
  ])('rejects %s, which is not a GitHub repo', async (repoUrl) => {
    await expect(createGitHubCloner(deps())(repoUrl)).rejects.toThrow(
      /Invalid GitHub URL or repo format/,
    );
    expect(clones).toHaveLength(0);
  });

  it.each([
    'HTTPS://GitHub.com/acme/widget.git',
    'git@GitHub.COM:acme/widget.git',
    'https://github.com/acme/widget/',
    'https://www.github.com/acme/widget',
    'https://github.com/acme/widget/tree/main',
    'https://github.com/acme/widget.git?tab=readme#top',
    'ssh://git@github.com/acme/widget.git',
    ' acme/widget/ ',
  ])('accepts %s as acme/widget', async (repoUrl) => {
    const clone = createGitHubCloner(deps())(repoUrl);
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    clones[0]?.exit(true);
    await expect(clone).resolves.toMatchObject({ path: clonePathFor('acme', 'widget') });
  });

  it.each([
    ['git@github.com:acme/widget.git', 'git@github.com:acme/widget.git'],
    ['ssh://git@github.com/acme/widget.git', 'ssh://git@github.com/acme/widget.git'],
    ['git@github.com-work:acme/widget.git', 'git@github.com-work:acme/widget.git'],
    ['ssh://git@GitHub.com-work/acme/widget.git', 'ssh://git@github.com-work/acme/widget.git'],
    [
      'ssh://git@github.com-work:2222/acme/widget.git',
      'ssh://git@github.com-work:2222/acme/widget.git',
    ],
    ['https://github.com/acme/widget', 'https://github.com/acme/widget.git'],
  ])('clones %s from %s', async (repoUrl, cloneUrl) => {
    const spawnArgs: string[][] = [];
    const clone = createGitHubCloner({
      ...deps(),
      spawnGit: (args) => {
        spawnArgs.push(args);
        return fakeSpawnGit(args);
      },
    })(repoUrl);
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    clones[0]?.exit(true);
    await clone;
    expect(spawnArgs[0]?.[1]).toBe(cloneUrl);
  });

  it('accepts an ssh host alias such as github.com-work', async () => {
    const clone = createGitHubCloner(deps())('git@github.com-work:acme/widget.git');
    await vi.waitFor(() => expect(clones).toHaveLength(1));
    clones[0]?.exit(true);
    await expect(clone).resolves.toMatchObject({ path: clonePathFor('acme', 'widget') });
  });

  it.each([
    '../widget',
    'acme/..',
    'acme/.',
    'https://github.com/../widget',
    'git@github.com:acme/../x',
  ])('rejects %s, which would resolve outside the clone root', async (repoUrl) => {
    await expect(createGitHubCloner(deps())(repoUrl)).rejects.toThrow(
      /Invalid GitHub URL or repo format/,
    );
    expect(clones).toHaveLength(0);
  });
});
