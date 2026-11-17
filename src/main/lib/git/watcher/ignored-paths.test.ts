import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGitDir } from './git-dir';
import { createIgnoreFilter } from './ignored-paths';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('ignore filter against a real repository', () => {
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'frink-ignore-')));
    git(repo, 'init', '-q');
    writeFileSync(path.join(repo, '.gitignore'), 'data/\n*.log\n');
    mkdirSync(path.join(repo, 'data'));
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'data', 'run.jsonl'), '{}\n');
    writeFileSync(path.join(repo, 'data', 'tracked.json'), '{}\n');
    writeFileSync(path.join(repo, 'src', 'index.ts'), '');
    git(repo, 'add', '-f', 'data/tracked.json');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('drops ignored paths and keeps the rest', async () => {
    const filter = createIgnoreFilter(repo);
    const kept = await filter.keepUnignored([
      path.join(repo, 'data', 'run.jsonl'),
      path.join(repo, 'debug.log'),
      path.join(repo, 'src', 'index.ts'),
    ]);
    expect(kept).toEqual([path.join(repo, 'src', 'index.ts')]);
  });

  it('keeps a tracked file that sits inside an ignored directory', async () => {
    const filter = createIgnoreFilter(repo);
    // Cache the sibling as ignored first: the answer must not spread to the directory.
    await filter.keepUnignored([path.join(repo, 'data', 'run.jsonl')]);
    const kept = await filter.keepUnignored([
      path.join(repo, 'data', 'run.jsonl'),
      path.join(repo, 'data', 'tracked.json'),
    ]);
    expect(kept).toEqual([path.join(repo, 'data', 'tracked.json')]);
  });

  it('keeps every path when none is ignored', async () => {
    const filter = createIgnoreFilter(repo);
    const paths = [path.join(repo, 'src', 'index.ts'), path.join(repo, 'README.md')];
    expect(await filter.keepUnignored(paths)).toEqual(paths);
  });

  it('keeps every path when git cannot answer', async () => {
    const notARepo = realpathSync(mkdtempSync(path.join(tmpdir(), 'frink-plain-')));
    try {
      const filter = createIgnoreFilter(notARepo);
      const paths = [path.join(notARepo, 'data', 'run.jsonl')];
      expect(await filter.keepUnignored(paths)).toEqual(paths);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  // The watcher reports real paths even when the project was opened through a symlink.
  it('filters real event paths for a project opened through a symlink', async () => {
    const link = `${repo}-link`;
    symlinkSync(repo, link);
    try {
      const gitDir = await resolveGitDir(link);
      expect(gitDir).toEqual({
        path: path.join(repo, '.git'),
        outsideWorktree: false,
        worktreeRoot: repo,
      });
      const filter = createIgnoreFilter(gitDir?.worktreeRoot ?? link);
      const kept = await filter.keepUnignored([
        path.join(repo, 'data', 'run.jsonl'),
        path.join(repo, 'src', 'index.ts'),
      ]);
      expect(kept).toEqual([path.join(repo, 'src', 'index.ts')]);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('handles spaces and non-ASCII characters in ignored file names', async () => {
    const filter = createIgnoreFilter(repo);
    const kept = await filter.keepUnignored([
      path.join(repo, 'data', 'rün 1 — log.jsonl'),
      path.join(repo, 'src', 'naïve file.ts'),
    ]);
    expect(kept).toEqual([path.join(repo, 'src', 'naïve file.ts')]);
  });

  it('drops a deleted ignored file and keeps a deleted tracked one', async () => {
    rmSync(path.join(repo, 'data', 'run.jsonl'));
    rmSync(path.join(repo, 'data', 'tracked.json'));
    const filter = createIgnoreFilter(repo);
    const kept = await filter.keepUnignored([
      path.join(repo, 'data', 'run.jsonl'),
      path.join(repo, 'data', 'tracked.json'),
    ]);
    expect(kept).toEqual([path.join(repo, 'data', 'tracked.json')]);
  });

  it('finds a linked worktree git dir outside its working tree', async () => {
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const linked = `${repo}-linked`;
    git(repo, 'worktree', 'add', '-q', linked);
    try {
      expect(await resolveGitDir(repo)).toEqual({
        path: path.join(repo, '.git'),
        outsideWorktree: false,
        worktreeRoot: repo,
      });
      expect(await resolveGitDir(linked)).toEqual({
        path: path.join(repo, '.git', 'worktrees', path.basename(linked)),
        outsideWorktree: true,
        worktreeRoot: linked,
      });
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it('reports no git dir outside a repository', async () => {
    const notARepo = realpathSync(mkdtempSync(path.join(tmpdir(), 'frink-plain-')));
    try {
      expect(await resolveGitDir(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('ignore filter caching', () => {
  const root = '/repo';
  const ignoredLog = '/repo/data/run.jsonl';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks git once for a path that keeps changing', async () => {
    const checkIgnore = vi.fn(async () => new Set(['data/run.jsonl']));
    const filter = createIgnoreFilter(root, checkIgnore);

    expect(await filter.keepUnignored([ignoredLog])).toEqual([]);
    expect(await filter.keepUnignored([ignoredLog])).toEqual([]);

    expect(checkIgnore).toHaveBeenCalledTimes(1);
    expect(checkIgnore).toHaveBeenCalledWith(root, ['data/run.jsonl']);
  });

  it('asks only about paths it has not seen', async () => {
    const checkIgnore = vi.fn(async () => new Set(['data/run.jsonl']));
    const filter = createIgnoreFilter(root, checkIgnore);

    await filter.keepUnignored([ignoredLog]);
    const kept = await filter.keepUnignored([ignoredLog, '/repo/src/a.ts']);

    expect(kept).toEqual(['/repo/src/a.ts']);
    expect(checkIgnore).toHaveBeenLastCalledWith(root, ['src/a.ts']);
  });

  it('asks again after a reset', async () => {
    const checkIgnore = vi
      .fn<() => Promise<Set<string>>>()
      .mockResolvedValueOnce(new Set(['data/run.jsonl']))
      .mockResolvedValueOnce(new Set());
    const filter = createIgnoreFilter(root, checkIgnore);

    expect(await filter.keepUnignored([ignoredLog])).toEqual([]);
    filter.reset();
    expect(await filter.keepUnignored([ignoredLog])).toEqual([ignoredLog]);
  });

  it('asks again once the cached answer is a minute old', async () => {
    vi.useFakeTimers();
    const checkIgnore = vi.fn(async () => new Set(['data/run.jsonl']));
    const filter = createIgnoreFilter(root, checkIgnore);

    await filter.keepUnignored([ignoredLog]);
    vi.advanceTimersByTime(60_000);
    await filter.keepUnignored([ignoredLog]);

    expect(checkIgnore).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failed check', async () => {
    const checkIgnore = vi
      .fn<() => Promise<Set<string> | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Set(['data/run.jsonl']));
    const filter = createIgnoreFilter(root, checkIgnore);

    expect(await filter.keepUnignored([ignoredLog])).toEqual([ignoredLog]);
    expect(await filter.keepUnignored([ignoredLog])).toEqual([]);
  });

  it('passes a very large batch through without asking git', async () => {
    const checkIgnore = vi.fn(async (_root: string, relPaths: string[]) => new Set(relPaths));
    const filter = createIgnoreFilter(root, checkIgnore);
    const paths = Array.from({ length: 2001 }, (_, i) => `/repo/data/${i}.jsonl`);

    expect(await filter.keepUnignored(paths)).toEqual(paths);
    expect(checkIgnore).not.toHaveBeenCalled();
    // The limit itself is still checked
    expect(await filter.keepUnignored(paths.slice(0, 2000))).toEqual([]);
    expect(checkIgnore).toHaveBeenCalledTimes(1);
  });

  it('checks a name that merely starts with two dots as inside the worktree', async () => {
    const checkIgnore = vi.fn(async () => new Set(['..cache/run.jsonl']));
    const filter = createIgnoreFilter(root, checkIgnore);

    expect(await filter.keepUnignored(['/repo/..cache/run.jsonl'])).toEqual([]);
    expect(checkIgnore).toHaveBeenCalledWith(root, ['..cache/run.jsonl']);
  });

  it('keeps paths outside the worktree without asking git', async () => {
    const checkIgnore = vi.fn(async () => new Set<string>());
    const filter = createIgnoreFilter(root, checkIgnore);

    expect(await filter.keepUnignored(['/elsewhere/file.ts'])).toEqual(['/elsewhere/file.ts']);
    expect(checkIgnore).not.toHaveBeenCalled();
  });

  it('asks git about paths relative to the worktree', async () => {
    const checkIgnore = vi.fn(async () => new Set<string>());
    const filter = createIgnoreFilter(root, checkIgnore);

    await filter.keepUnignored([path.join(root, 'data', 'nested', 'run.jsonl')]);

    expect(checkIgnore).toHaveBeenCalledWith(root, ['data/nested/run.jsonl']);
  });
});
