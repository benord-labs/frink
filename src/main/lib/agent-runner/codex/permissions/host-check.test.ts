import { describe, expect, it, vi } from 'vitest';
import { createCodexHostPermissionCheck } from './host-check';

type Validate = Parameters<typeof createCodexHostPermissionCheck>[0]['validateToolPermission'];

describe('createCodexHostPermissionCheck', () => {
  it('judges against the project and passes the folder Codex runs in', async () => {
    const validateToolPermission = vi.fn<Validate>(async () => ({ allowed: true }));
    const check = createCodexHostPermissionCheck({
      chatId: 'chat',
      subChatId: 'sub',
      projectPath: '/work-tree',
      permissionProjectPath: '/work',
      isFlowExecutionTurn: false,
      frinkMcpInjected: false,
      autoReview: false,
      executionSignal: new AbortController().signal,
      validateToolPermission,
    });
    await check({
      toolName: 'Bash',
      input: { command: 'echo x > out.txt', cwd: '/work-tree/pkg' },
    });
    expect(validateToolPermission.mock.calls[0]?.[2]).toBe('/work');
    expect(validateToolPermission.mock.calls[0]?.[13]).toBe('/work-tree');
    expect(validateToolPermission.mock.calls[0]?.[14]).toBe('/work-tree/pkg');
  });
});
