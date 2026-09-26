import { describe, expect, it } from 'vitest';
import {
  buildAgentEditorOpenInput,
  deriveProjectPathFromEditorPath,
} from './derive-project-path-from-editor-path';

describe('deriveProjectPathFromEditorPath', () => {
  it('prefers explicit worktree path when present', () => {
    expect(
      deriveProjectPathFromEditorPath('/repo/worktree/src/a.ts', 'src/a.ts', '/repo/worktree'),
    ).toBe('/repo/worktree');
  });

  it('derives project path from absolute editor path fallback', () => {
    expect(
      deriveProjectPathFromEditorPath(
        '/Users/me/project/src/views/file.tsx',
        'src/views/file.tsx',
        undefined,
      ),
    ).toBe('/Users/me/project');
  });

  it('returns undefined when fallback path cannot be derived', () => {
    expect(
      deriveProjectPathFromEditorPath(
        '/Users/me/project/src/views/file.tsx',
        'src/other/file.tsx',
        undefined,
      ),
    ).toBeUndefined();
  });

  it('returns empty project path when editor path equals display path', () => {
    expect(
      deriveProjectPathFromEditorPath('src/views/file.tsx', 'src/views/file.tsx', undefined),
    ).toBe('');
  });
});

describe('buildAgentEditorOpenInput', () => {
  it('uses derived project path fallback for absolute editor path without worktree', () => {
    expect(
      buildAgentEditorOpenInput({
        pathForEditor: '/Users/me/project/src/views/file.tsx',
        displayPath: 'src/views/file.tsx',
        worktreePath: undefined,
        filename: 'file.tsx',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'src/views/file.tsx',
      name: 'file.tsx',
      projectPath: '/Users/me/project',
      isWorktreeContext: false,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });

  it('uses worktree path and relative path in worktree context', () => {
    expect(
      buildAgentEditorOpenInput({
        pathForEditor: '/repo/worktree/src/views/file.tsx',
        displayPath: 'src/views/file.tsx',
        worktreePath: '/repo/worktree',
        filename: 'file.tsx',
        chatId: 'chat-1',
      }),
    ).toEqual({
      path: 'src/views/file.tsx',
      name: 'file.tsx',
      projectPath: '/repo/worktree',
      isWorktreeContext: true,
      sourceChatId: 'chat-1',
      intent: 'pinned',
    });
  });
});
