import { describe, expect, it, vi } from 'vitest';
import { createCodexHostPermissionCheck } from './host-check';

vi.mock('electron', () => ({ app: { getPath: () => '/mock' } }));

const worktree = '/wt/codex-lion';
const root = '/proj';

function check() {
  const validateToolPermission = vi.fn(async () => ({ allowed: true as const }));
  const run = createCodexHostPermissionCheck({
    chatId: 'c',
    subChatId: 's',
    projectPath: worktree,
    permissionProjectPath: root,
    isFlowExecutionTurn: false,
    frinkMcpInjected: false,
    autoReview: false,
    executionSignal: new AbortController().signal,
    validateToolPermission,
  });
  // SAFETY: vi.fn's call tuple is untyped; argument 7 is the path override.
  const override = () => (validateToolPermission.mock.calls[0] as unknown[])[6];
  return { run, override };
}

describe('createCodexHostPermissionCheck — permission path override', () => {
  it('remaps a worktree search root onto the canonical project, like PATH tools', async () => {
    const { run, override } = check();
    await run({ toolName: 'Grep', input: { pattern: 'x', path: `${worktree}/src` } });
    expect(override()).toBe('/proj/src');
  });

  it('a search with no path resolves to the worktree cwd, remapped to the project', async () => {
    const { run, override } = check();
    await run({ toolName: 'Glob', input: { pattern: '**/*.ts' } });
    expect(override()).toBe(root);
  });

  it('keeps an outside search root as-is', async () => {
    const { run, override } = check();
    await run({ toolName: 'Grep', input: { pattern: 'x', path: '/etc' } });
    expect(override()).toBe('/etc');
  });

  it('passes no override for Bash', async () => {
    const { run, override } = check();
    await run({ toolName: 'Bash', input: { command: 'ls' } });
    expect(override()).toBeUndefined();
  });
});
