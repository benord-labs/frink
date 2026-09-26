/**
 * removeWorktree: optional local branch deletion after worktree remove (sc-562).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

vi.mock('./shell-env', () => ({
  getGitEnv: vi.fn().mockResolvedValue({}),
}));

const logWarnMock = vi.hoisted(() => vi.fn());
vi.mock('electron-log', () => ({
  default: { warn: (...args: unknown[]) => logWarnMock(...args), info: vi.fn(), error: vi.fn() },
}));

type ExecFileCb = (error: Error | null, stdout?: string, stderr?: string) => void;

describe('removeWorktree', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    logWarnMock.mockReset();
  });

  it('runs only git worktree remove when branch option is omitted', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path');

    expect(r).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const argv = execFileMock.mock.calls[0][1] as string[];
    expect(argv).toContain('worktree');
    expect(argv).toContain('remove');
  });

  it('runs worktree remove then git branch -D when branch is provided', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path', { branch: 'curious-fox-abc123' });

    expect(r).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    const first = execFileMock.mock.calls[0][1] as string[];
    expect(first).toContain('worktree');

    const second = execFileMock.mock.calls[1][1] as string[];
    expect(second).toEqual(['-C', '/repo', 'branch', '-D', 'curious-fox-abc123']);
  });

  it('does not run branch -D for protected branch names', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path', { branch: 'main' });

    expect(r).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it('returns success when worktree remove succeeds but branch -D fails', async () => {
    let call = 0;
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        call += 1;
        if (call === 1) {
          cb(null, '', '');
          return;
        }
        const err = Object.assign(new Error('branch delete failed'), {
          code: 1,
          stderr: 'error: branch not found',
        });
        cb(err, '', 'error: branch not found');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path', { branch: 'stale-branch' });

    expect(r).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(logWarnMock).toHaveBeenCalled();
  });

  it('allows flow/* style local branch names (second call is branch -D)', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    await removeWorktree('/repo', '/wt/path', { branch: 'flow/feature-abc' });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    const second = execFileMock.mock.calls[1][1] as string[];
    expect(second).toEqual(['-C', '/repo', 'branch', '-D', 'flow/feature-abc']);
  });

  it('skips branch -D when branch is whitespace-only (treats like unset)', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path', { branch: '   \t  ' });

    expect(r).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('passes trimmed branch name to git branch -D', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    await removeWorktree('/repo', '/wt/path', { branch: '  curious-fox-abc123  ' });

    const second = execFileMock.mock.calls[1][1] as string[];
    expect(second).toEqual(['-C', '/repo', 'branch', '-D', 'curious-fox-abc123']);
  });

  it('treats protected branch names case-insensitively (no branch -D)', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path', { branch: 'MAIN' });

    expect(r).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt branch -D when options.branch is null', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(null, '', '');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path', { branch: null });

    expect(r).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('returns failure when worktree remove fails and does not run branch -D', async () => {
    execFileMock.mockImplementation(
      (_file: string, _argv: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(new Error('fatal: cannot lock'), '', 'cannot lock');
      },
    );
    const { removeWorktree } = await import('./worktree');
    const r = await removeWorktree('/repo', '/wt/path', { branch: 'feature-z' });

    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const argv = execFileMock.mock.calls[0][1] as string[];
    expect(argv).toContain('worktree');
  });
});
