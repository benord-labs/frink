import * as nodeFs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_TOOLS } from '../../../shared/types/permissions';
import * as claudeConfig from '../claude-config';
import { createTempDirRegistry, createTempProjectFile } from '../test-utils/temp-project';
import { isPathWithinProject } from './path-check';
import {
  extractFilePathFromToolInput,
  getOperationFromToolName,
  isClaudePermissionGatedTool,
  remapPathForPermissionBoundary,
  resolvePermissionProjectPath,
  resolveToolPermissionPath,
} from './tool-validation';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock') },
}));

const registry = createTempDirRegistry();

afterEach(async () => {
  await registry.cleanup();
});

async function createTempProject(): Promise<{ root: string; filePath: string }> {
  return createTempProjectFile(registry, 'frink-perm-', 'src/index.ts', 'export const x = 1;\n');
}

describe('isPathWithinProject', () => {
  it('returns true for in-project relative path', async () => {
    const { root } = await createTempProject();
    expect(isPathWithinProject('./src/index.ts', root)).toBe(true);
  });

  it('returns true for in-project absolute path', async () => {
    const { root, filePath } = await createTempProject();
    expect(isPathWithinProject(filePath, root)).toBe(true);
  });

  it('returns true for paths with dot segments that resolve inside project', async () => {
    const { root } = await createTempProject();
    expect(isPathWithinProject('./src/../src/index.ts', root)).toBe(true);
  });

  it('returns false for traversal path outside project', async () => {
    const { root } = await createTempProject();
    expect(isPathWithinProject('../outside.txt', root)).toBe(false);
  });

  it('does not treat similarly prefixed sibling directories as in-project', async () => {
    const parent = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'frink-prefix-'));
    registry.track(parent);
    const projectRoot = nodePath.join(parent, 'project');
    const siblingRoot = nodePath.join(parent, 'project-x');
    await nodeFs.promises.mkdir(projectRoot, { recursive: true });
    await nodeFs.promises.mkdir(siblingRoot, { recursive: true });
    const siblingFile = nodePath.join(siblingRoot, 'file.ts');
    await writeFile(siblingFile, 'export const y = 1;\n', 'utf8');

    expect(isPathWithinProject(siblingFile, projectRoot)).toBe(false);
  });

  it('handles symlinked project root with canonical absolute file path', async () => {
    if (process.platform === 'win32') {
      // Symlink creation can require elevated privileges on Windows CI.
      return;
    }

    const realRoot = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'frink-real-'));
    registry.track(realRoot);
    const filePath = nodePath.join(realRoot, 'README.md');
    await writeFile(filePath, '# test\n', 'utf8');

    const linkParent = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'frink-link-'));
    registry.track(linkParent);
    const linkRoot = nodePath.join(linkParent, 'project-link');
    await nodeFs.promises.symlink(realRoot, linkRoot);

    expect(isPathWithinProject(filePath, linkRoot)).toBe(true);
  });

  it('does not allow symlink inside project that points outside', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const { root } = await createTempProject();
    const externalRoot = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'frink-ext-'));
    registry.track(externalRoot);

    const externalFile = nodePath.join(externalRoot, 'secret.txt');
    await writeFile(externalFile, 'secret\n', 'utf8');

    const linkedPath = nodePath.join(root, 'linked-secret.txt');
    await nodeFs.promises.symlink(externalFile, linkedPath);

    expect(isPathWithinProject(linkedPath, root)).toBe(false);
  });
});

describe('extractFilePathFromToolInput', () => {
  it('returns path for Write when tool sends "file" (Claude raw input)', () => {
    expect(extractFilePathFromToolInput('Write', { file: '.env', content: 'KEY=val' })).toBe(
      '.env',
    );
  });

  it('returns path for Write when tool sends "file_path"', () => {
    expect(extractFilePathFromToolInput('Write', { file_path: '.env.example', content: '' })).toBe(
      '.env.example',
    );
  });

  it('prefers file_path over file', () => {
    expect(extractFilePathFromToolInput('Read', { file_path: '/a/b', file: '/c/d' })).toBe('/a/b');
  });

  it('keeps a valid fallback path when a sibling field has the wrong type', () => {
    expect(extractFilePathFromToolInput('Read', { file_path: null, file: '/c/d' })).toBe('/c/d');
  });

  it('returns path for MultiEdit and NotebookEdit (same keys as Write/Edit)', () => {
    expect(extractFilePathFromToolInput('MultiEdit', { file_path: '.env', edits: [] })).toBe(
      '.env',
    );
    expect(
      extractFilePathFromToolInput('NotebookEdit', {
        file: 'notebook.ipynb',
        old_string: '',
        new_string: '',
      }),
    ).toBe('notebook.ipynb');
  });
});

describe('resolvePermissionProjectPath', () => {
  it('returns input path when it is not a worktree path', () => {
    vi.spyOn(claudeConfig, 'resolveProjectPathFromWorktree').mockReturnValueOnce(null);
    const projectPath = '/tmp/my-project';
    expect(resolvePermissionProjectPath(projectPath)).toBe(projectPath);
  });

  it('returns resolved root project path for worktree path', () => {
    vi.spyOn(claudeConfig, 'resolveProjectPathFromWorktree').mockReturnValueOnce(
      '/Users/me/repos/project-a',
    );
    expect(resolvePermissionProjectPath('/tmp/worktrees/project-a/chat-1')).toBe(
      '/Users/me/repos/project-a',
    );
  });

  it('falls back to execution path when worktree resolution returns null', () => {
    vi.spyOn(claudeConfig, 'resolveProjectPathFromWorktree').mockReturnValueOnce(null);
    const worktreePath = '/tmp/worktrees/project-a/chat-missing';
    expect(resolvePermissionProjectPath(worktreePath)).toBe(worktreePath);
  });
});

describe('remapPathForPermissionBoundary', () => {
  it('remaps absolute worktree path to root-project-equivalent path', () => {
    const remapped = remapPathForPermissionBoundary(
      '/tmp/worktrees/project-a/chat-1/src/index.ts',
      '/tmp/worktrees/project-a/chat-1',
      '/Users/me/repos/project-a',
    );
    expect(remapped).toBe('/Users/me/repos/project-a/src/index.ts');
  });

  it('returns permission root when path equals worktree root', () => {
    const remapped = remapPathForPermissionBoundary(
      '/tmp/worktrees/project-a/chat-1',
      '/tmp/worktrees/project-a/chat-1',
      '/Users/me/repos/project-a',
    );
    expect(remapped).toBe('/Users/me/repos/project-a');
  });

  it('preserves absolute paths outside worktree root', () => {
    const remapped = remapPathForPermissionBoundary(
      '/tmp/other/location/file.ts',
      '/tmp/worktrees/project-a/chat-1',
      '/Users/me/repos/project-a',
    );
    expect(remapped).toBe('/tmp/other/location/file.ts');
  });

  it('remaps relative paths against execution root', () => {
    const remapped = remapPathForPermissionBoundary(
      'src/index.ts',
      '/tmp/worktrees/project-a/chat-1',
      '/Users/me/repos/project-a',
    );
    expect(remapped).toBe('/Users/me/repos/project-a/src/index.ts');
  });

  it('returns resolved path unchanged when execution and permission paths match', () => {
    const remapped = remapPathForPermissionBoundary(
      '/tmp/project/src/index.ts',
      '/tmp/project',
      '/tmp/project',
    );
    expect(remapped).toBe('/tmp/project/src/index.ts');
  });

  it('does not remap parent-traversal path that escapes worktree root', () => {
    const remapped = remapPathForPermissionBoundary(
      '/tmp/worktrees/project-a/chat-1/../outside.ts',
      '/tmp/worktrees/project-a/chat-1',
      '/Users/me/repos/project-a',
    );
    expect(remapped).toBe('/tmp/worktrees/project-a/outside.ts');
  });

  it('remaps paths with spaces and percent literals without decoding', () => {
    const remapped = remapPathForPermissionBoundary(
      '/tmp/worktrees/project a/chat%1/src/file%name.ts',
      '/tmp/worktrees/project a/chat%1',
      '/Users/me/repos/project a',
    );
    expect(remapped).toBe('/Users/me/repos/project a/src/file%name.ts');
  });
});

describe('resolveToolPermissionPath — search tools', () => {
  const worktree = '/tmp/worktrees/project-a/chat-1';
  const root = '/Users/me/repos/project-a';

  it('maps a search with no path to the permission root', () => {
    expect(resolveToolPermissionPath('Grep', { pattern: 'x' }, worktree, root)).toBe(root);
  });

  it('maps a worktree search folder into the permission root', () => {
    expect(resolveToolPermissionPath('Glob', { pattern: '*', path: 'src' }, worktree, root)).toBe(
      `${root}/src`,
    );
  });

  it('expands ~ instead of resolving it under the worktree', () => {
    expect(
      resolveToolPermissionPath('Grep', { pattern: 'x', path: '~/.ssh' }, worktree, root),
    ).toBe(nodePath.join(nodeOs.homedir(), '.ssh'));
  });
});

describe('getOperationFromToolName — regression coverage post TOOL_OPERATIONS refactor', () => {
  // Original switch-statement coverage — these must keep working.
  it.each([
    ['Read', 'read'],
    ['Glob', 'read'],
    ['Grep', 'read'],
    ['Write', 'write'],
    ['Edit', 'write'],
    ['MultiEdit', 'write'],
    ['NotebookEdit', 'write'],
    ['Bash', 'write'],
    ['Delete', 'delete'],
  ] as const)('%s → %s (pre-existing coverage preserved)', (tool, expected) => {
    expect(getOperationFromToolName(tool)).toBe(expected);
  });

  // New tools added to TOOL_OPERATIONS during this session — previously returned
  // null, now classified. Test pins the new behavior so a regression here
  // surfaces a regression in TOOL_OPERATIONS.
  it.each([
    ['Task', 'write'],
    ['Agent', 'write'], // Claude Code's current subagent tool — must classify like Task
    ['TodoWrite', 'write'],
    ['ExitPlanMode', 'write'],
    ['WebFetch', 'read'],
    ['WebSearch', 'read'],
  ] as const)('%s → %s (new in TOOL_OPERATIONS map)', (tool, expected) => {
    expect(getOperationFromToolName(tool)).toBe(expected);
  });

  // Subagent dispatch must be deny-protected under BOTH names so a rename can't
  // strand read-only/plan-mode chats (mirrors READONLY_EXEMPT_AGENT_TOOLS in executor.ts).
  it('treats both Task and Agent as required (deny-protected) subagent tools', () => {
    expect(REQUIRED_TOOLS.has('Task')).toBe(true);
    expect(REQUIRED_TOOLS.has('Agent')).toBe(true);
  });

  // sc-3852: the hand-back skips the permission gate entirely. Gating it would route it to the
  // generic no-rule `ask`, holding the parent's turn on a prompt for a sub-agent's report.
  it('keeps SubagentHandback required but out of the permission-gated and rule-target sets', () => {
    expect(REQUIRED_TOOLS.has('SubagentHandback')).toBe(true);
    expect(isClaudePermissionGatedTool('SubagentHandback')).toBe(false);
    expect(getOperationFromToolName('SubagentHandback')).toBeNull();
  });

  it('unknown tool returns null', () => {
    expect(getOperationFromToolName('NotARealTool')).toBeNull();
    expect(getOperationFromToolName('')).toBeNull();
  });

  it('MCP tools are NOT in TOOL_OPERATIONS (open universe) → null', () => {
    expect(getOperationFromToolName('mcp__shortcut__create_story')).toBeNull();
    expect(getOperationFromToolName('mcp__neon__*')).toBeNull();
  });

  it('case-sensitive — wrong case returns null', () => {
    expect(getOperationFromToolName('read')).toBeNull();
    expect(getOperationFromToolName('bash')).toBeNull();
    expect(getOperationFromToolName('READ')).toBeNull();
  });
});
