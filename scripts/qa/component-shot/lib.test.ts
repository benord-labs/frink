import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_CHANNELS,
  changedDependencyFiles,
  clearPreviousShots,
  EXIT_ABSENT_AT_BASE,
  EXIT_UNANSWERED,
  existsAtCommit,
  finishShots,
  linkNodeModules,
  nodeModulesLinkType,
  pageFailure,
  parseShotArgs,
  removeRunDir,
  resolveBaseCommit,
  settledValues,
} from './lib';

const REPO = '/repo';

describe('parseShotArgs', () => {
  it('fills the defaults and keeps the module repo-relative', () => {
    expect(parseShotArgs(['/repo/src/renderer/x.tsx', 'X'], REPO)).toEqual({
      modulePath: 'src/renderer/x.tsx',
      exportName: 'X',
      props: {},
      fixture: {},
      base: 'origin/main',
      width: 780,
      scale: 2,
      theme: 'dark',
      out: undefined,
    });
  });

  it('reads inline props and the shot options', () => {
    const options = parseShotArgs(
      [
        '/repo/a.tsx',
        'A',
        '--props',
        '{"projectId":"p1"}',
        '--width',
        '600',
        '--scale',
        '1',
        '--theme',
        'light',
      ],
      REPO,
    );
    expect(options).toMatchObject({
      props: { projectId: 'p1' },
      width: 600,
      scale: 1,
      theme: 'light',
    });
  });

  it('reads props and the fixture from files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    writeFileSync(join(dir, 'props.json'), '{"projectId":"p1"}');
    writeFileSync(join(dir, 'fixture.json'), '{"external.getHomePath":"/Users/sam"}');
    const options = parseShotArgs(
      [
        '/repo/a.tsx',
        'A',
        '--props-file',
        join(dir, 'props.json'),
        '--trpc-fixture',
        join(dir, 'fixture.json'),
      ],
      REPO,
    );
    rmSync(dir, { recursive: true });
    expect(options).toMatchObject({
      props: { projectId: 'p1' },
      fixture: { 'external.getHomePath': '/Users/sam' },
    });
  });

  it.each([
    [['/repo/a.tsx']],
    [['/repo/a.tsx', 'A', 'extra']],
    [['/repo/a.tsx', 'A', '--theme', 'sepia']],
    [['/repo/a.tsx', 'A', '--width', 'wide']],
    [['/repo/a.tsx', 'A', '--width', '0']],
    [['/repo/a.tsx', 'A', '--scale', 'Infinity']],
    [['/repo/a.tsx', 'A', '--props', '{}', '--props-file', 'p.json']],
    [['/elsewhere/a.tsx', 'A']],
    [['/repo/a.tsx', 'A', '--props', '[1]']],
  ])('rejects %j', (argv) => {
    expect(() => parseShotArgs(argv, REPO)).toThrow();
  });
});

describe('base resolution', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (file: string, body: string) => {
    writeFileSync(join(repo, file), body);
    git('add', file);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('uses the fork point, so commits that landed on the base later are not part of before', () => {
    repo = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    git('init', '-q', '-b', 'main');
    const fork = commit('a.tsx', 'a');
    git('switch', '-qc', 'feature');
    const head = commit('b.tsx', 'b');
    git('switch', '-q', 'main');
    commit('package.json', '{}');
    git('switch', '-q', 'feature');

    expect(resolveBaseCommit(repo, 'main')).toEqual({ base: fork, head });
    expect(existsAtCommit(repo, fork, 'a.tsx')).toBe(true);
    expect(existsAtCommit(repo, fork, 'b.tsx')).toBe(false);
    expect(changedDependencyFiles(repo, fork)).toEqual([]);
    writeFileSync(join(repo, 'package.json'), '{"name":"x"}');
    expect(changedDependencyFiles(repo, fork)).toEqual([]);
    git('add', 'package.json');
    expect(changedDependencyFiles(repo, fork)).toEqual(['package.json']);
  });

  it('returns the same commit for both sides when the branch has nothing new', () => {
    repo = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    git('init', '-q', '-b', 'main');
    const only = commit('a.tsx', 'a');
    expect(resolveBaseCommit(repo, 'main')).toEqual({ base: only, head: only });
  });

  it('fails loudly on a base ref this clone does not have, instead of shooting against HEAD', () => {
    repo = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    git('init', '-q', '-b', 'main');
    commit('a.tsx', 'a');
    expect(() => resolveBaseCommit(repo, 'origin/main')).toThrow(/origin\/main/);
  });
});

describe('run folders', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removing a run folder never deletes the node_modules it links to', () => {
    dir = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    const nodeModules = join(dir, 'repo-node_modules');
    mkdirSync(join(nodeModules, 'react'), { recursive: true });
    writeFileSync(join(nodeModules, 'react', 'index.js'), '');
    const runDir = join(dir, 'run');
    mkdirSync(join(runDir, 'base-tree'), { recursive: true });
    const links = [
      linkNodeModules(nodeModules, runDir),
      linkNodeModules(nodeModules, join(runDir, 'base-tree')),
    ];

    removeRunDir(runDir, links);
    removeRunDir(runDir, links);

    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(join(nodeModules, 'react', 'index.js'))).toBe(true);
  });

  it('clears shots from an earlier run, so a skipped before is never a stale one', () => {
    dir = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    writeFileSync(join(dir, 'before.png'), 'old');
    writeFileSync(join(dir, 'after.png'), 'old');
    writeFileSync(join(dir, 'notes.md'), 'keep');

    clearPreviousShots(dir);

    expect(existsSync(join(dir, 'before.png'))).toBe(false);
    expect(existsSync(join(dir, 'after.png'))).toBe(false);
    expect(existsSync(join(dir, 'notes.md'))).toBe(true);
  });
});

describe('platform choices', () => {
  it('links node_modules with a junction only on Windows', () => {
    expect(nodeModulesLinkType('win32')).toBe('junction');
    expect(nodeModulesLinkType('darwin')).toBe('dir');
    expect(nodeModulesLinkType('linux')).toBe('dir');
  });

  it('tries the installed browsers before a downloaded one', () => {
    expect(BROWSER_CHANNELS).toEqual(['chrome', 'msedge', undefined]);
  });
});

describe('pageFailure', () => {
  it('lets a rendered page through to the screenshot', () => {
    expect(pageFailure({ missing: ['a.b'], rendered: true }, ['noise'])).toBeNull();
  });

  it('reports an absent export without an error', () => {
    expect(pageFailure({ missing: [], absent: true }, [])).toEqual({ missing: [], absent: true });
  });

  it('treats a settled page with no root as a crash, with the page errors attached', () => {
    expect(pageFailure({ missing: [], rendered: false }, ['TypeError: x'])).toEqual({
      missing: [],
      error: 'the component unmounted\nTypeError: x',
    });
    expect(pageFailure({ missing: [], error: 'import failed' }, ['404'])).toEqual({
      missing: [],
      error: 'import failed\n404',
    });
  });
});

describe('finishShots', () => {
  const names = { exportName: 'X', modulePath: 'src/x.tsx', base: 'a2714f8d1e0000' };
  const shot = (png: string, missing: string[] = []) => ({ png, missing });

  it('exits 0 with both shots and lists each path once', () => {
    const report = finishShots({
      before: shot('/o/before.png'),
      after: shot('/o/after.png'),
      ...names,
    });
    expect(report).toEqual({
      lines: [
        'component harness render, not the full app',
        'before.png  /o/before.png',
        'after.png   /o/after.png',
      ],
      missing: [],
      code: 0,
    });
  });

  it('exits 3 when the component is new since the base', () => {
    const report = finishShots({
      before: { missing: [], absent: true },
      after: shot('/o/after.png'),
      ...names,
    });
    expect(report.code).toBe(EXIT_ABSENT_AT_BASE);
    expect(report.lines[1]).toBe('before.png  not written: X is absent at a2714f8d1e');
  });

  it('exits 2 on unanswered procedures, ahead of an absent base, listing each once', () => {
    const report = finishShots({
      before: { missing: ['a.get'], absent: true },
      after: shot('/o/after.png', ['a.get', 'b.list']),
      ...names,
    });
    expect(report).toMatchObject({ missing: ['a.get', 'b.list'], code: EXIT_UNANSWERED });
  });

  it('fails the run when a side failed or the export is missing from the working tree', () => {
    expect(() =>
      finishShots({ before: shot('b'), after: { missing: [], error: 'boom' }, ...names }),
    ).toThrow('after: boom');
    expect(() =>
      finishShots({ before: shot('b'), after: { missing: [], absent: true }, ...names }),
    ).toThrow('X is not exported from src/x.tsx');
    expect(() =>
      finishShots({ before: { missing: [], error: 'old' }, after: shot('a'), ...names }),
    ).toThrow('before: old');
  });
});

describe('settledValues', () => {
  it('returns every value in order when all sides succeeded', async () => {
    expect(settledValues(await Promise.allSettled([Promise.resolve('before'), 'after']))).toEqual([
      'before',
      'after',
    ]);
  });

  it('rethrows the first failure only after the other side has finished', async () => {
    let otherFinished = false;
    const slow = new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
      otherFinished = true;
    });
    const results = await Promise.allSettled([Promise.reject(new Error('timed out')), slow]);
    expect(otherFinished).toBe(true);
    expect(() => settledValues(results)).toThrow('timed out');
    expect(() => settledValues([{ status: 'rejected', reason: 'plain' }])).toThrow('plain');
  });
});
