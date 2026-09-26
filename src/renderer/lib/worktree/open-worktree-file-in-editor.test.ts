import { describe, expect, it } from 'vitest';
import { buildOpenWorktreeFileInput } from './open-worktree-file-in-editor';

describe('buildOpenWorktreeFileInput', () => {
  it('returns null when worktreePath is missing', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: 'src/index.ts',
        worktreePath: null,
        chatId: 'chat-1',
      }),
    ).toBeNull();
  });

  it('builds payload with relative path from relative file path', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: 'src/index.ts',
        worktreePath: '/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'src/index.ts',
      name: 'index.ts',
      projectPath: '/repo/worktree',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it('converts absolute file paths to relative using worktreePath', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: '/repo/worktree/src/absolute.ts',
        worktreePath: '/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'src/absolute.ts',
      name: 'absolute.ts',
      projectPath: '/repo/worktree',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it('rejects absolute file paths outside the worktree root', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: '/repo/other-project/src/escape.ts',
        worktreePath: '/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toBeNull();
  });

  it('preserves provider-style relative path prefixes', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: 'a/src/index.ts',
        worktreePath: '/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'a/src/index.ts',
      name: 'index.ts',
      projectPath: '/repo/worktree',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it('keeps URL-like paths as non-openable when they are not filesystem paths', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: 'file:///repo/worktree/src/index.ts',
        worktreePath: '/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toBeNull();
  });

  it('keeps raw path but decodes percent-encoded basename for display name', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: 'src/My%20File.ts',
        worktreePath: '/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'src/My%20File.ts',
      name: 'My File.ts',
      projectPath: '/repo/worktree',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it('falls back to raw basename when percent-decoding fails', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: 'src/Bad%ZZFile.ts',
        worktreePath: '/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'src/Bad%ZZFile.ts',
      name: 'Bad%ZZFile.ts',
      projectPath: '/repo/worktree',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it('handles windows absolute paths that use forward slashes', () => {
    expect(
      buildOpenWorktreeFileInput({
        filePath: 'C:/repo/worktree/src/index.ts',
        worktreePath: 'C:/repo/worktree',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'src/index.ts',
      name: 'index.ts',
      projectPath: 'C:/repo/worktree',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });
});
