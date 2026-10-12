import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCache } from './cache';
import { createStatusRouter } from './status';

let repo: string;
let scratch: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const write = (file: string, content: string) => writeFileSync(path.join(repo, file), content);
const getStatus = (worktreePath: string) =>
  createStatusRouter()
    .createCaller({ getWindow: () => null })
    .getStatus({ worktreePath });

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'status-real-git-'));
  scratch = mkdtempSync(path.join(tmpdir(), 'status-real-git-scratch-'));
  git('init', '-q', '-b', 'main');
  write('staged.txt', 'one\n');
  write('tracked.txt', 'one\n');
  git('add', '.');
  git('-c', 'user.name=Frink', '-c', 'user.email=frink@example.com', 'commit', '-qm', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs `run` with git tracing on and returns the git subcommands it spawned, in order. */
async function gitCommandsDuring(run: () => Promise<void>): Promise<string[]> {
  const traceFile = path.join(scratch, 'trace.jsonl');
  const env = { GIT_TRACE2_EVENT: traceFile, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    await run();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  const events: Array<{ event: string; argv?: string[] }> = readFileSync(traceFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return events.filter((entry) => entry.event === 'start').map((entry) => entry.argv?.[1] ?? '');
}

describe('changes.getStatus against a real repository', () => {
  it('groups uncommitted files into staged, unstaged and untracked', async () => {
    write('added.txt', 'new\n');
    write('staged.txt', 'changed\n');
    git('add', 'added.txt', 'staged.txt');
    write('tracked.txt', 'one\ntwo\n');
    write('untracked.txt', 'x\n');

    expect(await getStatus(repo)).toEqual({
      branch: 'main',
      staged: [
        { path: 'added.txt', status: 'added' },
        { path: 'staged.txt', status: 'modified' },
      ],
      unstaged: [{ path: 'tracked.txt', status: 'modified' }],
      untracked: [{ path: 'untracked.txt', status: 'untracked' }],
    });
  });

  it('lists a file under both staged and unstaged when it changed again after staging', async () => {
    write('tracked.txt', 'staged edit\n');
    git('add', 'tracked.txt');
    write('tracked.txt', 'later edit\n');

    expect(await getStatus(repo)).toEqual({
      branch: 'main',
      staged: [{ path: 'tracked.txt', status: 'modified' }],
      unstaged: [{ path: 'tracked.txt', status: 'modified' }],
      untracked: [],
    });
  });

  it('returns three empty lists for a clean repository', async () => {
    expect(await getStatus(repo)).toEqual({
      branch: 'main',
      staged: [],
      unstaged: [],
      untracked: [],
    });
  });

  it('runs git status once and answers a repeat call from the cache', async () => {
    write('untracked.txt', 'x\n');

    const commands = await gitCommandsDuring(async () => {
      await getStatus(repo);
      await getStatus(repo);
    });

    expect(commands).toEqual(['status']);
  });

  // The branch label reads this instead of listing every branch and worktree on each refresh.
  it('reports the checked-out branch, and no branch once detached', async () => {
    git('switch', '-q', '-c', 'feature/x');
    expect((await getStatus(repo)).branch).toBe('feature/x');

    git('switch', '-q', '--detach');
    // The watcher invalidates the cache on a HEAD change; do the same here
    gitCache.invalidateStatus(repo);
    expect((await getStatus(repo)).branch).toBeNull();
  });

  // A watcher invalidation that lands while git status runs must not be undone by its late result
  it('does not cache a status read that started before an invalidation', async () => {
    const generation = gitCache.statusGeneration(repo);
    gitCache.invalidateStatus(repo);
    gitCache.setStatus(repo, { branch: 'stale' }, generation);
    expect(gitCache.getStatus(repo)).toBeNull();

    expect((await getStatus(repo)).branch).toBe('main');
    expect(gitCache.getStatus(repo)).toMatchObject({ branch: 'main' });
  });

  it('rejects for a folder that is not a git repository', async () => {
    await expect(getStatus(scratch)).rejects.toThrow(/not a git repository/i);
  });
});
