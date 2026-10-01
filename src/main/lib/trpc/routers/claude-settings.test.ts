import { beforeEach, describe, expect, it, vi } from 'vitest';

const mkdirMock = vi.fn();
const writeFileMock = vi.fn();
const unlinkMock = vi.fn();
const accessMock = vi.fn();
const statMock = vi.fn();
const mkdtempMock = vi.fn();
const rmMock = vi.fn();
const setWorktreeBasePathMock = vi.fn();
const resetWorktreeBasePathMock = vi.fn();
const resolveWorktreeBasePathMock = vi.fn();

vi.mock('../../worktree/base-path-config', () => ({
  DEFAULT_WORKTREE_BASE_PATH: '/Users/test/.frink/worktrees',
  FRINK_WORKTREE_CONFIG_PATH: '/Users/test/.frink/worktrees/config.json',
  setWorktreeBasePath: setWorktreeBasePathMock,
  resetWorktreeBasePath: resetWorktreeBasePathMock,
  resolveWorktreeBasePath: resolveWorktreeBasePathMock,
}));

vi.mock('node:fs/promises', () => ({
  access: accessMock,
  stat: statMock,
  mkdtemp: mkdtempMock,
  rm: rmMock,
  mkdir: mkdirMock,
  writeFile: writeFileMock,
  unlink: unlinkMock,
  readFile: vi.fn(),
}));

// Mock the electron-dependent claude barrel: control the bundled version; keep the real >= 2.1.173
// support rule so the capability query's version→supportsXhigh wiring is what's under test.
const getBundledClaudeVersionMock = vi.fn();
vi.mock('../../claude', () => ({
  getBundledClaudeVersion: getBundledClaudeVersionMock,
  claudeVersionSupportsXhigh: (v: string | null) => v === '2.1.200',
  claudeVersionSupportsUltra: (v: string | null) => v === '2.1.200',
}));

describe('validateAndNormalizeWorktreeBasePath', () => {
  beforeEach(() => {
    mkdirMock.mockReset();
    writeFileMock.mockReset();
    unlinkMock.mockReset();
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    accessMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ isDirectory: () => false });
    mkdtempMock.mockResolvedValue('/tmp/mock-dir');
    rmMock.mockResolvedValue(undefined);
    setWorktreeBasePathMock.mockReset();
    resetWorktreeBasePathMock.mockReset();
    resolveWorktreeBasePathMock.mockReset();
    setWorktreeBasePathMock.mockResolvedValue('/Users/test/custom-worktrees');
    resetWorktreeBasePathMock.mockResolvedValue(undefined);
    resolveWorktreeBasePathMock.mockResolvedValue('/Users/test/.frink/worktrees');
  });

  it('rejects root path', async () => {
    const { validateAndNormalizeWorktreeBasePath } = await import('./claude-settings');
    await expect(validateAndNormalizeWorktreeBasePath('/')).rejects.toThrow(
      'Please choose a more specific directory for worktrees',
    );
  });

  it('rejects relative paths', async () => {
    const { validateAndNormalizeWorktreeBasePath } = await import('./claude-settings');
    await expect(validateAndNormalizeWorktreeBasePath('relative/worktrees')).rejects.toThrow(
      'Worktree base path must be an absolute path',
    );
  });

  it('normalizes ~ and validates writability', async () => {
    const { validateAndNormalizeWorktreeBasePath } = await import('./claude-settings');
    const normalizedPath = await validateAndNormalizeWorktreeBasePath('~/worktrees-custom');

    expect(normalizedPath.endsWith('/worktrees-custom')).toBe(true);
    expect(mkdirMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('surfaces write validation failures', async () => {
    writeFileMock.mockRejectedValueOnce(new Error('permission denied'));
    const { validateAndNormalizeWorktreeBasePath } = await import('./claude-settings');

    await expect(validateAndNormalizeWorktreeBasePath('/tmp/worktrees')).rejects.toThrow(
      'permission denied',
    );
  });
});

describe('claudeSettingsRouter', () => {
  it('getBundledClaudeCapabilities returns version + supportsXhigh (supported)', async () => {
    getBundledClaudeVersionMock.mockReturnValue('2.1.200');
    const { claudeSettingsRouter } = await import('./claude-settings');
    const caller = claudeSettingsRouter.createCaller({ getWindow: () => null });
    expect(await caller.getBundledClaudeCapabilities()).toEqual({
      version: '2.1.200',
      supportsXhigh: true,
      supportsUltra: true,
    });
  });

  it('getBundledClaudeCapabilities reports supportsXhigh=false for an old bundled binary', async () => {
    getBundledClaudeVersionMock.mockReturnValue('2.1.97');
    const { claudeSettingsRouter } = await import('./claude-settings');
    const caller = claudeSettingsRouter.createCaller({ getWindow: () => null });
    expect(await caller.getBundledClaudeCapabilities()).toEqual({
      version: '2.1.97',
      supportsXhigh: false,
      supportsUltra: false,
    });
  });

  it('returns route payload shape for getWorktreeBasePath', async () => {
    const { claudeSettingsRouter } = await import('./claude-settings');
    const caller = claudeSettingsRouter.createCaller({ getWindow: () => null });

    const result = await caller.getWorktreeBasePath();
    expect(result).toEqual({
      path: '/Users/test/.frink/worktrees',
      defaultPath: '/Users/test/.frink/worktrees',
      configPath: '/Users/test/.frink/worktrees/config.json',
      isDefault: true,
    });
  });

  it('calls setWorktreeBasePath route handler and returns payload', async () => {
    const { claudeSettingsRouter } = await import('./claude-settings');
    const caller = claudeSettingsRouter.createCaller({ getWindow: () => null });

    const setResult = await caller.setWorktreeBasePath({ path: '/Users/test/custom-worktrees' });
    expect(setWorktreeBasePathMock).toHaveBeenCalled();
    expect(setResult).toEqual({
      success: true,
      path: '/Users/test/custom-worktrees',
    });
  });

  it('calls resetWorktreeBasePath route handler and returns payload', async () => {
    const { claudeSettingsRouter } = await import('./claude-settings');
    const caller = claudeSettingsRouter.createCaller({ getWindow: () => null });

    const resetResult = await caller.resetWorktreeBasePath();
    expect(resetWorktreeBasePathMock).toHaveBeenCalled();
    expect(resetResult).toEqual({
      success: true,
      path: '/Users/test/.frink/worktrees',
    });
  });
});
