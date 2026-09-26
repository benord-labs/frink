import { describe, expect, it } from 'vitest';
import {
  normalizePathForComparison,
  resolveActiveWorktreePath,
  resolveEffectiveProjectPath,
  resolveScopedChatWorktreePath,
} from './resolve-effective-project-path';

describe('normalizePathForComparison', () => {
  it('normalizes slashes and trims trailing separators', () => {
    expect(normalizePathForComparison('C:\\repo\\worktree\\')).toBe('c:/repo/worktree');
  });

  it('normalizes Windows path casing for case-insensitive comparisons', () => {
    expect(normalizePathForComparison('C:\\Repo\\WorkTree\\')).toBe('c:/repo/worktree');
  });

  it('returns null for nullish values', () => {
    expect(normalizePathForComparison(null)).toBeNull();
    expect(normalizePathForComparison(undefined)).toBeNull();
  });
});

describe('resolveActiveWorktreePath', () => {
  it('returns undefined when raw worktree path is nullish', () => {
    expect(
      resolveActiveWorktreePath({
        rawWorktreePath: null,
        selectedProjectPath: '/repos/my-project',
      }),
    ).toBeUndefined();
  });

  it('returns undefined when worktree path equals selected project path after normalization', () => {
    expect(
      resolveActiveWorktreePath({
        rawWorktreePath: '/repos/my-project/',
        selectedProjectPath: '/repos/my-project',
      }),
    ).toBeUndefined();
  });

  it('returns worktree path when it differs from selected project path', () => {
    expect(
      resolveActiveWorktreePath({
        rawWorktreePath: '/tmp/.frink/worktrees/my-project/wt-1',
        selectedProjectPath: '/repos/my-project',
      }),
    ).toBe('/tmp/.frink/worktrees/my-project/wt-1');
  });

  it('supports worktree-to-base switching semantics', () => {
    const asWorktree = resolveActiveWorktreePath({
      rawWorktreePath: '/tmp/.frink/worktrees/my-project/wt-1',
      selectedProjectPath: '/repos/my-project',
    });
    const asBaseProject = resolveActiveWorktreePath({
      rawWorktreePath: '/repos/my-project',
      selectedProjectPath: '/repos/my-project',
    });

    expect(asWorktree).toBe('/tmp/.frink/worktrees/my-project/wt-1');
    expect(asBaseProject).toBeUndefined();
  });
});

describe('resolveScopedChatWorktreePath', () => {
  it('returns queried worktree when query chat matches active chat', () => {
    expect(
      resolveScopedChatWorktreePath({
        activeChatId: 'chat-2',
        queriedChatId: 'chat-2',
        queriedWorktreePath: '/tmp/.frink/worktrees/proj/wt-2',
      }),
    ).toBe('/tmp/.frink/worktrees/proj/wt-2');
  });

  it('falls back when queried chat does not match active chat (stale response)', () => {
    expect(
      resolveScopedChatWorktreePath({
        activeChatId: 'chat-2',
        queriedChatId: 'chat-1',
        queriedWorktreePath: '/tmp/.frink/worktrees/proj/wt-1',
        fallbackWorktreePath: '/repos/proj',
      }),
    ).toBe('/repos/proj');
  });

  it('updates scoped worktree when active chat changes', () => {
    const first = resolveScopedChatWorktreePath({
      activeChatId: 'chat-1',
      queriedChatId: 'chat-1',
      queriedWorktreePath: '/tmp/.frink/worktrees/proj/wt-1',
      fallbackWorktreePath: '/repos/proj',
    });
    const second = resolveScopedChatWorktreePath({
      activeChatId: 'chat-2',
      queriedChatId: 'chat-2',
      queriedWorktreePath: '/tmp/.frink/worktrees/proj/wt-2',
      fallbackWorktreePath: '/repos/proj',
    });

    expect(first).toBe('/tmp/.frink/worktrees/proj/wt-1');
    expect(second).toBe('/tmp/.frink/worktrees/proj/wt-2');
  });
});

describe('resolveEffectiveProjectPath', () => {
  it('prefers worktree path when present', () => {
    const result = resolveEffectiveProjectPath({
      worktreePath: '/tmp/.frink/worktrees/my-project/wt-1',
      selectedProjectPath: '/repos/my-project',
    });

    expect(result).toBe('/tmp/.frink/worktrees/my-project/wt-1');
  });

  it('falls back to selected project path when worktree path is absent', () => {
    const result = resolveEffectiveProjectPath({
      worktreePath: undefined,
      selectedProjectPath: '/repos/my-project',
    });

    expect(result).toBe('/repos/my-project');
  });

  it('returns undefined when both paths are missing', () => {
    const result = resolveEffectiveProjectPath({
      worktreePath: undefined,
      selectedProjectPath: undefined,
    });

    expect(result).toBeUndefined();
  });
});
