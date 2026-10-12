import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeMemoryProjectRoot, claudeProjectDirName, resolveClaudeAutoMemorySettings } from '.';

let tmpRoot: string;
let home: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe',
  });

/** A repo with one commit, so worktrees and clones can be made from it. */
function makeRepo(name: string): string {
  const repo = path.join(tmpRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return fs.realpathSync.native(repo);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-auto-memory-'));
  home = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  vi.stubEnv('FRINK_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Vectors evaluated from the bundled CLI's (2.1.289) own slug functions.
describe('claudeProjectDirName', () => {
  it('turns every non-alphanumeric into a dash', () => {
    expect(claudeProjectDirName('/Users/benji/Desktop/Personal and learning/frink-oss')).toBe(
      '-Users-benji-Desktop-Personal-and-learning-frink-oss',
    );
    expect(claudeProjectDirName('/Users/dev/café')).toBe('-Users-dev-caf-');
  });

  it('cuts a name past 200 chars and suffixes the int32 string hash of the root', () => {
    const root = `/Users/dev/${'deeply-nested-folder/'.repeat(12)}app`;
    const cut = `-Users-dev${'-deeply-nested-folder'.repeat(9)}-`;
    expect(cut).toHaveLength(200);
    expect(claudeProjectDirName(root)).toBe(`${cut}-pdvgun`);
  });
});

describe('claudeMemoryProjectRoot', () => {
  it('keys a repo and any subdirectory by the repo root', () => {
    const repo = makeRepo('repo');
    fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
    expect(claudeMemoryProjectRoot(repo)).toBe(repo);
    expect(claudeMemoryProjectRoot(path.join(repo, 'packages', 'app'))).toBe(repo);
  });

  it('keys a linked worktree by its main checkout', () => {
    const repo = makeRepo('repo');
    const worktree = path.join(tmpRoot, 'worktrees', 'feature');
    git(repo, 'worktree', 'add', '-q', worktree);
    expect(claudeMemoryProjectRoot(worktree)).toBe(repo);
    expect(claudeMemoryProjectRoot(path.join(worktree, '.'))).toBe(repo);
  });

  it('keys a worktree of a bare repo by the bare repo', () => {
    const repo = makeRepo('origin');
    const bare = path.join(tmpRoot, 'bare.git');
    git(tmpRoot, 'clone', '-q', '--bare', repo, bare);
    const worktree = path.join(tmpRoot, 'bare-worktree');
    git(bare, 'worktree', 'add', '-q', worktree);
    expect(claudeMemoryProjectRoot(worktree)).toBe(fs.realpathSync.native(bare));
  });

  it('keys a submodule subdirectory by the submodule root', () => {
    const library = makeRepo('library');
    const app = makeRepo('app');
    git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    fs.mkdirSync(path.join(app, 'lib', 'src'));
    expect(claudeMemoryProjectRoot(path.join(app, 'lib', 'src'))).toBe(path.join(app, 'lib'));
  });

  it('keys a folder outside any repo by its physical, NFC path', () => {
    const folder = path.join(tmpRoot, 'café');
    fs.mkdirSync(folder);
    const root = claudeMemoryProjectRoot(folder);
    expect(root).toBe(fs.realpathSync.native(folder).normalize('NFC'));
    expect(root.endsWith('café')).toBe(true);
  });
});

describe('resolveClaudeAutoMemorySettings', () => {
  const writeUserSettings = (settings: {
    autoMemoryDirectory?: string;
    autoMemoryEnabled?: boolean;
  }) => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));

  it("points at the project's folder under ~/.claude/projects", () => {
    const repo = makeRepo('repo');
    expect(resolveClaudeAutoMemorySettings(repo)).toEqual({
      autoMemoryDirectory: path.join(
        home,
        '.claude',
        'projects',
        claudeProjectDirName(repo),
        'memory',
      ),
    });
  });

  it("uses the user's own absolute or ~/ autoMemoryDirectory, expanded against FRINK_HOME", () => {
    writeUserSettings({ autoMemoryDirectory: '~/notes/memory' });
    expect(resolveClaudeAutoMemorySettings(tmpRoot).autoMemoryDirectory).toBe(
      path.join(home, 'notes', 'memory'),
    );
    writeUserSettings({ autoMemoryDirectory: '/srv/memory' });
    expect(resolveClaudeAutoMemorySettings(tmpRoot).autoMemoryDirectory).toBe('/srv/memory');
  });

  it('ignores a directory the CLI would reject, and unreadable settings', () => {
    const expected = resolveClaudeAutoMemorySettings(tmpRoot);
    writeUserSettings({ autoMemoryDirectory: 'relative/memory' });
    expect(resolveClaudeAutoMemorySettings(tmpRoot)).toEqual(expected);
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
    expect(resolveClaudeAutoMemorySettings(tmpRoot)).toEqual(expected);
  });

  it("carries the user's auto-memory off switch", () => {
    writeUserSettings({ autoMemoryEnabled: false });
    expect(resolveClaudeAutoMemorySettings(tmpRoot).autoMemoryEnabled).toBe(false);
    writeUserSettings({ autoMemoryEnabled: true });
    expect(resolveClaudeAutoMemorySettings(tmpRoot)).not.toHaveProperty('autoMemoryEnabled');
  });
});
