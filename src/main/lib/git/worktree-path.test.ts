import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveWorktreeBasePathMock = vi.fn();
const generateWorktreeFolderNameMock = vi.fn();
const detectWorktreeConfigMock = vi.fn();

vi.mock('../worktree/base-path-config', () => ({
  resolveWorktreeBasePath: resolveWorktreeBasePathMock,
}));

vi.mock('./worktree-naming', () => ({
  generateWorktreeFolderName: generateWorktreeFolderNameMock,
}));

vi.mock('./worktree-config', () => ({
  detectWorktreeConfig: detectWorktreeConfigMock,
  awaitWorktreeSetup: vi.fn().mockResolvedValue(null),
  startWorktreeSetup: vi.fn(),
}));

describe('buildChatWorktreePath', () => {
  beforeEach(() => {
    resolveWorktreeBasePathMock.mockReset();
    generateWorktreeFolderNameMock.mockReset();
    detectWorktreeConfigMock.mockReset();
  });

  it('rejects invalid project slugs that could escape the worktrees base directory', async () => {
    resolveWorktreeBasePathMock.mockResolvedValue('/Volumes/dev/worktrees');
    generateWorktreeFolderNameMock.mockReturnValue('misty-ridge');
    detectWorktreeConfigMock.mockResolvedValue({
      config: null,
      path: null,
      source: null,
    });

    const { buildChatWorktreePath } = await import('./worktree');

    await expect(buildChatWorktreePath('../evil', '/repo/main')).rejects.toThrow(
      'Invalid project slug',
    );
    await expect(buildChatWorktreePath('nested/path', '/repo/main')).rejects.toThrow(
      'Invalid project slug',
    );
    await expect(buildChatWorktreePath('nested\\path', '/repo/main')).rejects.toThrow(
      'Invalid project slug',
    );
  });

  it('uses global default base path when project override is absent', async () => {
    resolveWorktreeBasePathMock.mockResolvedValue('/Volumes/dev/worktrees');
    generateWorktreeFolderNameMock.mockReturnValue('misty-ridge');
    detectWorktreeConfigMock.mockResolvedValue({
      config: null,
      path: null,
      source: null,
    });

    const { buildChatWorktreePath } = await import('./worktree');
    const result = await buildChatWorktreePath('my-project', '/repo/main');

    expect(generateWorktreeFolderNameMock).toHaveBeenCalledWith(
      '/Volumes/dev/worktrees/my-project',
    );
    expect(result.worktreePath).toBe('/Volumes/dev/worktrees/my-project/misty-ridge');
  });

  it('uses project-level override when configured in .frink/worktrees.json', async () => {
    resolveWorktreeBasePathMock.mockResolvedValue('/Volumes/dev/worktrees');
    generateWorktreeFolderNameMock.mockReturnValue('coastal-mesa');
    detectWorktreeConfigMock.mockResolvedValue({
      config: { 'worktree-base-path': '/Projects/my-worktrees' },
      path: '/repo/main/.frink/worktrees.json',
      source: 'frink',
    });

    const { buildChatWorktreePath } = await import('./worktree');
    const result = await buildChatWorktreePath('my-project', '/repo/main');

    expect(generateWorktreeFolderNameMock).toHaveBeenCalledWith(
      '/Projects/my-worktrees/my-project',
    );
    expect(result.worktreePath).toBe('/Projects/my-worktrees/my-project/coastal-mesa');
  });

  it('ignores unsafe project override paths and falls back to global default base path', async () => {
    resolveWorktreeBasePathMock.mockResolvedValue('/Volumes/dev/worktrees');
    generateWorktreeFolderNameMock.mockReturnValue('safe-fallback');
    detectWorktreeConfigMock.mockResolvedValue({
      config: { 'worktree-base-path': '/etc' },
      path: '/repo/main/.frink/worktrees.json',
      source: 'frink',
    });

    const { buildChatWorktreePath } = await import('./worktree');
    const result = await buildChatWorktreePath('my-project', '/repo/main');

    expect(generateWorktreeFolderNameMock).toHaveBeenCalledWith(
      '/Volumes/dev/worktrees/my-project',
    );
    expect(result.worktreePath).toBe('/Volumes/dev/worktrees/my-project/safe-fallback');
  });
});
