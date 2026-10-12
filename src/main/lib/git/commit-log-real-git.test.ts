import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMIT_HISTORY_FORMAT, gitLogArgs, parseCommitHistory } from './commit-log';
import { GIT_LOG_FORMAT, parseGitLog } from './utils/parse-status';

// Runs the production format strings and args against real git so a drift
// between what git emits and what the parsers expect cannot hide behind fixtures.

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const commit = (...args: string[]) =>
  git(
    '-c',
    'user.name=Ada',
    '-c',
    'user.email=ada@example.com',
    'commit',
    '-q',
    '--allow-empty',
    ...args,
  );

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'commit-log-'));
  git('init', '-q');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('commit log parsing against real git output', () => {
  it('parses multi-line bodies, "|" and empty subjects with GIT_LOG_FORMAT', () => {
    commit('-m', 'fix: a | b', '-m', 'Body line 1\nBody | line 2');
    commit('--allow-empty-message', '-m', '');
    commit('-m', 'plain');

    const commits = parseGitLog(git(...gitLogArgs(GIT_LOG_FORMAT)));

    expect(commits.map((c) => c.message)).toEqual(['plain', '', 'fix: a | b']);
    expect(commits[2]).toMatchObject({
      description: 'Body line 1\nBody | line 2',
      author: 'Ada',
    });
    expect(commits.map((c) => c.hash)).toEqual(git('rev-list', 'HEAD').trim().split('\n'));
  });

  it('parses COMMIT_HISTORY_FORMAT output with email and a real ISO date', () => {
    commit('-m', 'subject | with pipe');

    const [entry] = parseCommitHistory(git(...gitLogArgs(COMMIT_HISTORY_FORMAT, '-5')));

    expect(entry).toMatchObject({ message: 'subject | with pipe', email: 'ada@example.com' });
    expect(entry?.date).toBe(new Date(git('log', '-1', '--format=%aI').trim()).toISOString());
  });
});

function setUpSshSigning(): void {
  const key = path.join(repo, '.key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const pub = readFileSync(`${key}.pub`, 'utf8').trim();
  writeFileSync(path.join(repo, '.allowed'), `ada@example.com ${pub}\n`);
  git('config', 'gpg.format', 'ssh');
  git('config', 'user.signingkey', `${key}.pub`);
  git('config', 'gpg.ssh.allowedSignersFile', path.join(repo, '.allowed'));
}

/** SSH signing needs ssh-keygen and git >= 2.34; probe once so older hosts skip instead of fail. */
function canSshSign(): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), 'commit-log-probe-'));
  const previous = repo;
  try {
    repo = probe;
    git('init', '-q');
    setUpSshSigning();
    commit('-S', '-m', 'probe');
    return true;
  } catch {
    return false;
  } finally {
    repo = previous;
    rmSync(probe, { recursive: true, force: true });
  }
}

describe.skipIf(!canSshSign())('with log.showSignature=true and signed commits', () => {
  beforeEach(() => {
    setUpSshSigning();
    commit('-S', '-m', 'first signed');
    commit('-S', '-m', 'second signed');
    git('config', 'log.showSignature', 'true');
  });

  it('git really prints signature lines on stdout (precondition)', () => {
    expect(git('log', `--format=%H`)).toContain('signature');
  });

  it('returns clean hashes from parseGitLog', () => {
    const commits = parseGitLog(git(...gitLogArgs(GIT_LOG_FORMAT)));
    expect(commits.map((c) => c.hash)).toEqual(git('rev-list', 'HEAD').trim().split('\n'));
  });

  it('returns clean hashes from parseCommitHistory', () => {
    const entries = parseCommitHistory(git(...gitLogArgs(COMMIT_HISTORY_FORMAT, '-50')));
    expect(entries.map((e) => e.hash)).toEqual(git('rev-list', 'HEAD').trim().split('\n'));
    expect(entries.map((e) => e.message)).toEqual(['second signed', 'first signed']);
  });

  it('parser alone drops the signature preamble even if the flag is omitted', () => {
    const commits = parseGitLog(git('log', GIT_LOG_FORMAT));
    expect(commits.map((c) => c.hash)).toEqual(git('rev-list', 'HEAD').trim().split('\n'));
  });
});
