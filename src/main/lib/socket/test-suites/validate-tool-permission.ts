import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as socketClient from '../client';
import {
  _clearActiveExecutionsForTests,
  _registerExecutionForTests,
} from '../streaming/execution-registry';
import {
  hasPendingPermissionRequest,
  validateToolPermission,
} from '../streaming/pending-permission/validate-tool-permission';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';
import { registerPermissionDbUnavailableTests } from './executor-permission-db-unavailable';

type PermissionBridgeHarness = Pick<ExecutorPermissionHarness, 'clientPermissionBridge'>;

function validateWithNativeReview(tool: string, input: Record<string, unknown>) {
  return validateToolPermission(
    tool,
    input,
    '/proj',
    'c1',
    's1',
    undefined,
    undefined,
    false,
    true,
  );
}

/** Registers the permission prompt cases against the parent executor test harness and its mocks. */
export function registerValidateToolPermissionTests(harness: PermissionBridgeHarness): void {
  describe('validateToolPermission (v2 wrapper)', () => {
    beforeEach(async () => {
      _clearActiveExecutionsForTests();
      vi.mocked(socketClient.sendPermissionRequest).mockClear();
      const { getProjectByPath } = await import('../../db/repos/projects');
      vi.mocked(getProjectByPath).mockResolvedValue({
        id: 'project-1',
        name: 'Project One',
        path: '/proj',
      } as unknown as Awaited<ReturnType<typeof getProjectByPath>>);
      const { checkPermission } = await import('../../permissions/v2/check');
      vi.mocked(checkPermission).mockResolvedValue({ decision: 'allow' });
    });

    registerPermissionDbUnavailableTests({ ...harness, validateWithNativeReview });
    registerDispatcherDecisionTests(harness);
    registerPromptContextTests(harness);
  });
}

function registerDispatcherDecisionTests({
  clientPermissionBridge,
}: PermissionBridgeHarness): void {
  it('returns allow when projectPath is undefined (boot-window contract)', async () => {
    const r = await validateToolPermission('Bash', { command: 'ls' }, undefined, 'c1', 's1');
    expect(r).toEqual({ allowed: true });
  });

  it('takes the decision from the dispatcher', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'db:unavailable' },
    });
    const r = await validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c1', 's1');
    expect(vi.mocked(checkPermission)).toHaveBeenCalled();
    expect(r).toMatchObject({ allowed: false });
  });

  it('returns allow when dispatcher returns allow', async () => {
    const r = await validateToolPermission('Bash', { command: 'npm test' }, '/proj', 'c1', 's1');
    expect(r).toEqual({ allowed: true });
  });

  it('returns deny with formatDenyReason message when dispatcher returns deny', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Bash(rm:*)', tier: 'user' },
    });
    const r = await validateToolPermission('Bash', { command: 'rm -rf /' }, '/proj', 'c1', 's1');
    expect(r).toEqual({
      allowed: false,
      message: expect.stringMatching(/user.*Bash\(rm:\*\)/),
    });
  });

  it('delegates only the ask residual to a provider-native reviewer', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    const r = await validateToolPermission(
      'Bash',
      { command: 'npm test' },
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      true,
    );

    expect(r).toEqual({ allowed: null });
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
    const allowed = await validateWithNativeReview('Bash', { command: 'npm test' });
    expect(allowed).toEqual({ allowed: true });
  });

  it('routes a Flow MCP ask through Frink with the complete permission context', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    const { persistApprovedRule } = await import('../../permissions/v2/persist-approved-rule');
    vi.mocked(persistApprovedRule).mockClear();
    const tool = 'mcp__frink_dynamic_chat__frink_flows_patch';
    const input = { flowId: 'flow-1720', operations: [{ op: 'update_settings' }] };
    const prompt = {
      tool,
      input,
      reason: 'no-matching-rule' as const,
      suggestedRules: [tool, 'mcp__frink_dynamic_chat__*'],
    };
    vi.mocked(checkPermission).mockResolvedValueOnce({ decision: 'ask', prompt });
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      expect(payload).toMatchObject({
        chatId: 'flow-chat-1720',
        subChatId: '11111111-1111-4111-8111-111111111111',
        type: 'mcp_tool',
        operation: 'mcp_tool',
        toolName: tool,
        projectName: 'Project One',
        projectPath: '/proj',
        path: 'flow tool: frink_flows_patch',
        reason: 'Flow tool: frink_flows_patch',
        prompt,
      });
      clientPermissionBridge.lastResponseHandler?.({
        ...payload,
        approved: true,
        duration: 'once',
      });
    });

    const result = await validateToolPermission(
      tool,
      input,
      '/proj',
      'flow-chat-1720',
      '11111111-1111-4111-8111-111111111111',
      'Flow tool: frink_flows_patch',
      'flow tool: frink_flows_patch',
      false,
      false,
    );

    expect(result).toEqual({ allowed: true });
    expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce();
    expect(persistApprovedRule).toHaveBeenCalledWith(
      expect.objectContaining({ promptResult: expect.objectContaining({ duration: 'once' }) }),
    );
  });

  it('cancels a pending Flow permission from its captured execution, not a successor', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    const { persistApprovedRule } = await import('../../permissions/v2/persist-approved-rule');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    vi.mocked(persistApprovedRule).mockClear();
    vi.mocked(socketClient.sendPermissionRequest).mockImplementation(() => {});
    const oldController = new AbortController();
    const successorController = new AbortController();
    _registerExecutionForTests('flow-abort-sub', successorController);

    const pending = validateToolPermission(
      'mcp__frink_dynamic_chat__frink_flows_patch',
      { flowId: 'flow-abort' },
      '/proj',
      'flow-abort-chat',
      'flow-abort-sub',
      'Flow tool: frink_flows_patch',
      'flow tool: frink_flows_patch',
      false,
      false,
      oldController.signal,
    );
    await vi.waitFor(() => expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce());
    expect(hasPendingPermissionRequest('flow-abort-sub')).toBe(true);

    oldController.abort();

    await expect(pending).resolves.toMatchObject({ allowed: false });
    expect(hasPendingPermissionRequest('flow-abort-sub')).toBe(false);
    expect(successorController.signal.aborted).toBe(false);
    expect(socketClient.sendPermissionDismiss).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'flow-abort-chat',
        subChatId: 'flow-abort-sub',
      }),
    );
    const requestId = vi.mocked(socketClient.sendPermissionRequest).mock.calls[0]?.[0].requestId;
    if (!requestId) throw new Error('Expected a pending permission request');
    clientPermissionBridge.lastResponseHandler?.({
      chatId: 'flow-abort-chat',
      subChatId: 'flow-abort-sub',
      requestId,
      approved: true,
      duration: 'always',
    });
    expect(persistApprovedRule).not.toHaveBeenCalled();
  });
}

function registerPromptContextTests({ clientPermissionBridge }: PermissionBridgeHarness): void {
  it('returns deny with safety:path message for SYSTEM_DENIED_PATTERNS hits', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'safety:path', path: '/proj/.env' },
    });
    const r = await validateWithNativeReview('Read', { file_path: '/proj/.env' });
    expect(r.allowed).toBe(false);
    expect((r as { message: string }).message).toContain('/proj/.env');
  });

  it('passes projectPath (NOT permissionPathOverride) to getProjectByPath', async () => {
    const { getProjectByPath } = await import('../../db/repos/projects');
    vi.mocked(getProjectByPath).mockClear();
    await validateToolPermission(
      'Edit',
      { file_path: '/worktree/abc/src/foo.ts' },
      '/proj',
      'c1',
      's1',
      undefined,
      '/proj/src/foo.ts', // permissionPathOverride is a FILE path, not project
    );
    expect(getProjectByPath).toHaveBeenCalledWith(expect.anything(), '/proj');
  });

  it('passes projectId+projectPath to checkPermission', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockClear();
    await validateToolPermission('Bash', { command: 'pwd' }, '/proj', 'c1', 's1');
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'Bash',
        projectId: 'project-1',
        projectPath: '/proj',
      }),
    );
  });

  it('routes a general-chat Write to an ask whose payload has no projectPath', async () => {
    const h = os.homedir();
    const { getProjectByPath } = await import('../../db/repos/projects');
    vi.mocked(getProjectByPath).mockResolvedValueOnce(null);
    const { checkPermission } = await import('../../permissions/v2/check');
    const ask = { decision: 'ask', prompt: { reason: 'no-matching-rule' } };
    vi.mocked(checkPermission).mockResolvedValueOnce(
      ask as Awaited<ReturnType<typeof checkPermission>>,
    );
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      expect(payload).not.toHaveProperty('projectPath');
      clientPermissionBridge.lastResponseHandler?.({ ...payload, approved: false });
    });
    const r = await validateToolPermission('Write', { file_path: `${h}/n.md` }, h, 'c1', 's1');
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'Write', projectId: '', projectPath: h }),
    );
    expect(r).toEqual({ allowed: false, message: 'User denied permission' });
  });

  function respondTimedOut(): void {
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      clientPermissionBridge.lastResponseHandler?.({
        chatId: payload.chatId,
        subChatId: payload.subChatId,
        requestId: payload.requestId,
        approved: false,
        timedOut: true,
      });
    });
  }

  it('prompt wait stays under the CLI 600s per-hook abort (else the deny reason is discarded)', async () => {
    const { PERMISSION_PROMPT_TIMEOUT_MS } = await import('../../permissions/constants');
    expect(PERMISSION_PROMPT_TIMEOUT_MS).toBeLessThan(600_000);
  });

  it('timeout deny tells the model the user did NOT deny (no flow steer outside flows)', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    respondTimedOut();
    const r = await validateToolPermission(
      'Bash',
      { command: 'devkit help ship' },
      '/proj',
      'c1',
      's1',
    );
    expect(r.allowed).toBe(false);
    const msg = (r as { message: string }).message;
    expect(msg).toContain('timed out');
    expect(msg).toContain('did NOT deny');
    expect(msg).not.toContain('frink_task_signal');
  });

  it('flow-driven timeout steers the agent to park via frink_task_signal awaiting_input', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    respondTimedOut();
    const r = await validateToolPermission(
      'Bash',
      { command: 'devkit help ship' },
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      true,
    );
    expect(r.allowed).toBe(false);
    const msg = (r as { message: string }).message;
    expect(msg).toContain('did NOT deny');
    expect(msg).toContain('frink_task_signal');
    expect(msg).toContain('awaiting_input');
  });
}
