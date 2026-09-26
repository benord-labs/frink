import { expect, it, vi } from 'vitest';
import type { PermissionPresentation } from '../../../../shared/types/permissions';
import { getPreToolUseHook, type PreToolUseQueryInput } from '../test-utils';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type CustomNodeTransportHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute' | 'socketClient'
> & { claudeQueryMock: ReturnType<typeof vi.fn> };

type ClaudeToolDecision =
  | { behavior: 'allow'; updatedInput?: object }
  | { behavior: 'deny'; message: string };
type ClaudeToolInput = { packagePath?: string };

type CustomNodeQueryInput = PreToolUseQueryInput & {
  options?: NonNullable<PreToolUseQueryInput['options']> & {
    canUseTool?: (
      toolName: string,
      toolInput: ClaudeToolInput,
      options: { toolUseID: string },
    ) => Promise<ClaudeToolDecision>;
  };
};

export function registerCustomNodeTransportTest({
  basePayload,
  claudeQueryMock,
  handleRemoteExecute,
  socketClient,
}: CustomNodeTransportHarness): void {
  it('lets canonical node registration reach snapshot-bound authorization without an early prompt', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockClear();

    let hookResult: unknown;
    claudeQueryMock.mockImplementationOnce(async function* (queryInput: CustomNodeQueryInput) {
      hookResult = await getPreToolUseHook(queryInput)(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__frink_dynamic_chat__frink_register_node',
          tool_input: { packagePath: 'examples/custom-nodes/read-colocated-image' },
        },
        'tool-register-node-1',
      );
      yield { type: 'result', chunks: [{ type: 'finish' }] };
    });

    await handleRemoteExecute({ ...basePayload, message: 'register the example node' });

    expect(hookResult).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: { packagePath: 'examples/custom-nodes/read-colocated-image' },
      },
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps Claude canUseTool transport-only for canonical node registration', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockClear();

    let decision: unknown;
    claudeQueryMock.mockImplementationOnce(async function* (queryInput: CustomNodeQueryInput) {
      const canUseTool = queryInput.options?.canUseTool;
      if (!canUseTool) throw new Error('Missing canUseTool callback');
      decision = await canUseTool(
        'mcp__frink_dynamic_chat__frink_register_node',
        { packagePath: 'examples/custom-nodes/read-colocated-image' },
        { toolUseID: 'tool-register-node-fallback-1' },
      );
      yield { type: 'result', chunks: [{ type: 'finish' }] };
    });

    await handleRemoteExecute({ ...basePayload, message: 'register the example node' });

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { packagePath: 'examples/custom-nodes/read-colocated-image' },
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  }, 15_000);
}

export function registerCustomNodePermissionTests({
  clientPermissionBridge,
  socketClient,
  validateToolPermission,
}: ExecutorPermissionHarness): void {
  it('attaches only the trusted host registration presentation to the permission prompt', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    const tool = 'mcp__frink_dynamic_chat__frink_register_node';
    const input = { packagePath: 'examples/custom-nodes/read-colocated-image' };
    const presentation = {
      type: 'custom-node-registration' as const,
      packagePath: input.packagePath,
      action: 'create' as const,
      node: { name: 'read-colocated-image', entrypoint: 'index.js' },
      source: { current: "console.log('ok');" },
      modules: [],
      resources: [{ path: 'cinder.png', bytes: 5795, change: 'added' as const }],
      credentialNames: [],
      packageDigest: 'a'.repeat(64),
      packageBytes: 6000,
      warning: 'Runs unsandboxed and may execute unattended from a Flow.',
    };
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { tool, input, reason: 'no-matching-rule' },
    });
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      expect(payload.prompt?.presentation).toEqual(presentation);
      clientPermissionBridge.lastResponseHandler?.({
        ...payload,
        approved: true,
        duration: 'once',
      });
    });

    await expect(
      validateToolPermission(
        tool,
        input,
        '/proj',
        'flow-chat-register',
        '11111111-1111-4111-8111-111111111111',
        'Flow tool: frink_register_node',
        'flow tool: frink_register_node',
        false,
        false,
        undefined,
        undefined,
        undefined,
        presentation,
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it('fails closed when a registration presentation is attached to a noncanonical tool', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockClear();
    const presentation = {
      type: 'custom-node-registration',
      packagePath: 'nodes/read-image',
      action: 'create',
      node: { name: 'read-image', entrypoint: 'index.js' },
      source: { current: "console.log('ok');" },
      modules: [],
      resources: [],
      credentialNames: [],
      packageDigest: 'a'.repeat(64),
      packageBytes: 32,
      warning: 'Runs unsandboxed.',
    } satisfies PermissionPresentation;

    await expect(
      validateToolPermission(
        'mcp__untrusted__frink_register_node',
        { packagePath: presentation.packagePath },
        '/proj',
        'flow-chat-register',
        '11111111-1111-4111-8111-111111111111',
        undefined,
        undefined,
        false,
        false,
        undefined,
        undefined,
        undefined,
        presentation,
      ),
    ).resolves.toEqual({
      allowed: false,
      message: 'Invalid permission presentation — tool blocked',
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('fails closed when the canonical tool receives a malformed presentation', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(checkPermission).mockClear();
    // SAFETY: Deliberately malformed runtime payload verifies fail-closed parsing.
    const malformedPresentation = {
      type: 'custom-node-registration',
      packagePath: 'nodes/read-image',
      action: 'create',
      node: { name: 'read-image', entrypoint: 'index.js' },
      source: { current: "console.log('ok');" },
      modules: [],
      resources: [],
      credentialNames: [],
      packageDigest: 'not-a-source-digest',
      packageBytes: 32,
      warning: 'Runs unsandboxed.',
    } as never;

    await expect(
      validateToolPermission(
        'mcp__frink_dynamic_chat__frink_register_node',
        { packagePath: 'nodes/read-image' },
        '/proj',
        'flow-chat-register',
        '11111111-1111-4111-8111-111111111111',
        undefined,
        undefined,
        false,
        false,
        undefined,
        undefined,
        undefined,
        malformedPresentation,
      ),
    ).resolves.toEqual({
      allowed: false,
      message: 'Invalid permission presentation — tool blocked',
    });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });
}
