import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusMock = vi.fn();
const rawMock = vi.fn();
const simpleGitFactoryMock = vi.fn(() => ({
  status: statusMock,
  raw: rawMock,
}));

const parseGitStatusMock = vi.fn();
const UNTRACKED_TOO_LARGE_SIZE_BYTES = 2 * 1024 * 1024 + 1;

const statMock = vi.fn();
const readFileBufferMock = vi.fn();

vi.mock('simple-git', () => ({
  default: simpleGitFactoryMock,
}));

vi.mock('./utils/parse-status', () => ({
  GIT_LOG_FORMAT: '--format=%H',
  parseGitStatus: parseGitStatusMock,
  parseGitLog: vi.fn(() => []),
  parseNameStatus: vi.fn(() => []),
}));

vi.mock('./security', () => ({
  secureFs: {
    stat: statMock,
    readFileBuffer: readFileBufferMock,
    readFile: vi.fn(),
  },
}));

describe('createStatusRouter.getWorkingFileLineChanges', () => {
  beforeEach(() => {
    statusMock.mockReset();
    rawMock.mockReset();
    simpleGitFactoryMock.mockReset();
    parseGitStatusMock.mockReset();
    statMock.mockReset();
    readFileBufferMock.mockReset();

    simpleGitFactoryMock.mockImplementation(() => ({
      status: statusMock,
      raw: rawMock,
    }));

    statusMock.mockResolvedValue({});
    parseGitStatusMock.mockReturnValue({ untracked: [] });
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'src/a.ts';
      return '';
    });
  });

  it('returns parsed ranges for tracked file diffs', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'src/a.ts';
      return `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,1 +10,2 @@
-one
+one
+two`;
    });

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getWorkingFileLineChanges({
      worktreePath: '/repo',
      filePath: '/repo/src/a.ts',
    });

    expect(result).toEqual({
      ranges: [
        { type: 'modified', startLine: 10, endLine: 10 },
        { type: 'added', startLine: 11, endLine: 11 },
      ],
      unsupported: false,
    });
    expect(rawMock).toHaveBeenCalledWith(['ls-files', '--error-unmatch', '--', 'src/a.ts']);
    expect(rawMock).toHaveBeenCalledWith([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      'HEAD',
      '--',
      'src/a.ts',
    ]);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('rethrows unexpected diff errors', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'src/new-file.ts';
      throw new Error('fatal: bad revision HEAD');
    });

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    await expect(
      caller.getWorkingFileLineChanges({
        worktreePath: '/repo',
        filePath: '/repo/src/new-file.ts',
      }),
    ).rejects.toThrow('fatal: bad revision HEAD');
  });

  it('marks all lines as added for untracked files', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') throw new Error('not tracked');
      return '';
    });
    statMock.mockResolvedValue({ size: 20 });
    readFileBufferMock.mockResolvedValue(Buffer.from('line 1\nline 2\nline 3', 'utf-8'));

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getWorkingFileLineChanges({
      worktreePath: '/repo',
      filePath: '/repo/src/new-file.ts',
    });

    expect(result).toEqual({
      ranges: [{ type: 'added', startLine: 1, endLine: 3 }],
      unsupported: false,
    });
    expect(rawMock).toHaveBeenCalledWith(['ls-files', '--error-unmatch', '--', 'src/new-file.ts']);
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it('returns unsupported for untracked large files', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') throw new Error('not tracked');
      return '';
    });
    statMock.mockResolvedValue({ size: UNTRACKED_TOO_LARGE_SIZE_BYTES });

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getWorkingFileLineChanges({
      worktreePath: '/repo',
      filePath: 'src/new-file.ts',
    });

    expect(result).toEqual({ ranges: [], unsupported: true });
    expect(readFileBufferMock).not.toHaveBeenCalled();
  });

  it('returns unsupported for untracked binary files', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') throw new Error('not tracked');
      return '';
    });
    statMock.mockResolvedValue({ size: 256 });
    readFileBufferMock.mockResolvedValue(Buffer.from([0, 1, 2, 3]));

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getWorkingFileLineChanges({
      worktreePath: '/repo',
      filePath: './src/new-file.ts',
    });

    expect(result).toEqual({ ranges: [], unsupported: true });
    expect(rawMock).toHaveBeenCalledWith(['ls-files', '--error-unmatch', '--', 'src/new-file.ts']);
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it('gracefully returns empty ranges when untracked file stats fail', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') throw new Error('not tracked');
      return '';
    });
    const err = new Error('permission denied');
    (err as Error & { code?: string }).code = 'EACCES';
    statMock.mockRejectedValue(err);

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getWorkingFileLineChanges({
      worktreePath: '/repo',
      filePath: '/repo/src/new-file.ts',
    });

    expect(result).toEqual({ ranges: [], unsupported: false });
  });

  it('normalizes subdirectory worktree paths', async () => {
    rawMock.mockImplementation(async (_args: string[]) => 'src/index.ts');
    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    await caller.getWorkingFileLineChanges({
      worktreePath: '/repo/packages/app',
      filePath: '/repo/packages/app/src/index.ts',
    });

    expect(rawMock).toHaveBeenCalledWith(['ls-files', '--error-unmatch', '--', 'src/index.ts']);
    expect(rawMock).toHaveBeenCalledWith([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      'HEAD',
      '--',
      'src/index.ts',
    ]);
  });

  it('throws for files outside worktree path', async () => {
    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    await expect(
      caller.getWorkingFileLineChanges({
        worktreePath: '/repo',
        filePath: '/other-repo/src/index.ts',
      }),
    ).rejects.toThrow('File path must be within worktree');
    expect(rawMock).not.toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('returns unsupported fallback for non-git directories', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'file.ts';
      throw new Error('not a git repository');
    });

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getWorkingFileLineChanges({
      worktreePath: '/not-a-repo',
      filePath: '/not-a-repo/file.ts',
    });

    expect(result).toEqual({ ranges: [], unsupported: true });
  });

  it('returns unsupported for tracked binary diffs', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'src/a.bin';
      return 'Binary files a/src/a.bin and b/src/a.bin differ';
    });

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getWorkingFileLineChanges({
      worktreePath: '/repo',
      filePath: '/repo/src/a.bin',
    });

    expect(result).toEqual({ ranges: [], unsupported: true });
  });

  it('returns empty content for untracked files in getOriginalContent', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') throw new Error('not tracked');
      return '';
    });

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getOriginalContent({
      worktreePath: '/repo',
      filePath: '/repo/src/new-file.ts',
    });

    expect(result).toEqual({ content: '' });
    expect(rawMock).toHaveBeenCalledWith(['ls-files', '--error-unmatch', '--', 'src/new-file.ts']);
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it('returns HEAD content for tracked files in getOriginalContent', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'src/existing.ts';
      return '';
    });
    const showMock = vi.fn(async () => 'const value = 1;\n');
    simpleGitFactoryMock.mockImplementation(() => ({
      status: statusMock,
      raw: rawMock,
      show: showMock,
    }));

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getOriginalContent({
      worktreePath: '/repo',
      filePath: '/repo/src/existing.ts',
    });

    expect(result).toEqual({ content: 'const value = 1;\n' });
    expect(rawMock).toHaveBeenCalledWith(['ls-files', '--error-unmatch', '--', 'src/existing.ts']);
    expect(showMock).toHaveBeenCalledWith(['HEAD:src/existing.ts']);
  });

  it('returns null content when tracked file HEAD read fails in getOriginalContent', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'src/existing.ts';
      return '';
    });
    const showMock = vi.fn(async () => {
      throw new Error('fatal: bad revision HEAD');
    });
    simpleGitFactoryMock.mockImplementation(() => ({
      status: statusMock,
      raw: rawMock,
      show: showMock,
    }));

    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    const result = await caller.getOriginalContent({
      worktreePath: '/repo',
      filePath: '/repo/src/existing.ts',
    });

    expect(result).toEqual({ content: null });
    expect(showMock).toHaveBeenCalledWith(['HEAD:src/existing.ts']);
  });

  it('normalizes file path in getCommitFileDiff', async () => {
    rawMock.mockResolvedValue('diff --git a/src/a.ts b/src/a.ts');
    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    await caller.getCommitFileDiff({
      worktreePath: '/repo',
      commitHash: 'abcdef1234567',
      filePath: '/repo/src/a.ts',
    });

    expect(rawMock).toHaveBeenCalledWith([
      'diff',
      'abcdef1234567^',
      'abcdef1234567',
      '--',
      'src/a.ts',
    ]);
  });

  it('accepts caret-style HEAD refs in getCommitFileDiff', async () => {
    rawMock.mockResolvedValue('diff --git a/src/a.ts b/src/a.ts');
    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    await caller.getCommitFileDiff({
      worktreePath: '/repo',
      commitHash: 'HEAD^2',
      filePath: '/repo/src/a.ts',
    });

    expect(rawMock).toHaveBeenCalledWith(['diff', 'HEAD^2^', 'HEAD^2', '--', 'src/a.ts']);
  });

  it('rejects invalid commit hash format in getCommitFileDiff', async () => {
    const { createStatusRouter } = await import('./status');
    const caller = createStatusRouter().createCaller({ getWindow: () => null });

    await expect(
      caller.getCommitFileDiff({
        worktreePath: '/repo',
        commitHash: 'not a hash',
        filePath: '/repo/src/a.ts',
      }),
    ).rejects.toThrow('Invalid commit hash format');
  });
});
