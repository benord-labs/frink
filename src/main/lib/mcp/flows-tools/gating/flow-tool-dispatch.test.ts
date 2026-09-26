import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
import { FLOW_PERMISSION_SUMMARIES } from '../../../../../shared/types/flows/flow-change-presentation';
import type { JsonValue } from '../../../../../shared/types/permissions';
import type { McpToolResult } from '../../tool-result';
import type { RequestFlowConsent } from './flow-invocation-consent';
import {
  dispatchFlowToolCall,
  type FlowConsentStore,
  type FlowGateContext,
  gateFlowWrite,
  type ValidateFlowWrite,
} from './flow-tool-dispatch';

const state = vi.hoisted(() => ({
  handleFlowsToolCall: vi.fn(),
  validateToolPermission: vi.fn(),
  getFlow: vi.fn(),
  updateFlow: vi.fn(),
  listFlowBatchStages: vi.fn(),
  requestFlowConsent: vi.fn(),
}));

vi.mock('..', () => ({
  FLOWS_TOOL_NAMES: new Set([
    'frink_flows_patch',
    'frink_flows_list',
    'frink_flows_run',
    'frink_flows_start_batch',
    'frink_register_node',
  ]),
  handleFlowsToolCall: (...args: unknown[]) => state.handleFlowsToolCall(...args),
}));

/** The gate receives its flow reads/writes as a plain injected object. */
const flowStore = {
  getFlow: (...args: unknown[]) => state.getFlow(...args),
  updateFlow: (...args: unknown[]) => state.updateFlow(...args),
  listFlowBatchStages: (...args: unknown[]) => state.listFlowBatchStages(...args),
} as unknown as FlowConsentStore;

const validateWrite = ((...args: unknown[]) =>
  state.validateToolPermission(...args)) as unknown as ValidateFlowWrite;

const FLOW_RESULT: McpToolResult = {
  content: [{ type: 'text', text: 'flows-ok' }],
  isError: false,
};

function makeCtx(overrides: Partial<FlowGateContext> = {}): FlowGateContext {
  return {
    chatId: 'chat-1',
    subChatId: 'sub-1',
    projectPath: '/project',
    autoReviewTools: false,
    isFlowDrivenTurn: false,
    ...overrides,
  };
}

type DispatchOverrides = {
  name?: string;
  mode?: ChatMode;
  flowsEnabled?: boolean;
  channelAddressed?: boolean;
  ctx?: FlowGateContext | null;
  isExecutionCurrent?: () => boolean;
  requestFlowConsent?: RequestFlowConsent | null;
  args?: Record<string, unknown>;
  providerPreapproved?: boolean;
};

function dispatch(overrides: DispatchOverrides = {}) {
  return dispatchFlowToolCall({
    name: overrides.name ?? 'frink_flows_patch',
    args: overrides.args ?? { flowId: 'flow-1' },
    executionId: 'execution-1',
    channelAddressed: overrides.channelAddressed,
    ctx: 'ctx' in overrides ? overrides.ctx : makeCtx(),
    projectPath: '/project',
    mode: overrides.mode ?? 'agent',
    flowsEnabled: overrides.flowsEnabled ?? true,
    validateWrite,
    requestFlowConsent:
      'requestFlowConsent' in overrides
        ? (overrides.requestFlowConsent ?? undefined)
        : (...args: unknown[]) => state.requestFlowConsent(...args),
    flowStore,
    isExecutionCurrent: overrides.isExecutionCurrent,
    providerPreapproved: overrides.providerPreapproved,
  });
}

function resultText(result: McpToolResult | null): string {
  if (!result) throw new Error('Expected a Flow tool result');
  return result.content[0]?.text ?? '';
}

describe('dispatchFlowToolCall', () => {
  beforeEach(() => {
    state.handleFlowsToolCall.mockReset();
    state.handleFlowsToolCall.mockResolvedValue(FLOW_RESULT);
    state.validateToolPermission.mockReset();
    state.validateToolPermission.mockResolvedValue({ allowed: true });
    state.getFlow.mockReset();
    state.getFlow.mockResolvedValue({
      id: 'flow-1',
      name: 'Nightly digest',
      agent_invocable: false,
      is_enabled: true,
      graph: { nodes: [{ id: 'n1', blockType: 'run_command' }], edges: [] },
    });
    state.updateFlow.mockReset();
    state.updateFlow.mockResolvedValue(undefined);
    state.listFlowBatchStages.mockReset();
    state.listFlowBatchStages.mockResolvedValue({ stages: [{ run_count: 3 }, { run_count: 4 }] });
    state.requestFlowConsent.mockReset();
    state.requestFlowConsent.mockResolvedValue('once');
  });

  it('returns null without gating for non-Flow tools', async () => {
    expect(dispatch({ name: 'searchProjects' })).toBeNull();
    expect(state.validateToolPermission).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('returns a structured no-write result for an unavailable patch tool', async () => {
    const result = await dispatch({ flowsEnabled: false });

    expect(result?.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toEqual({
      status: 'failure',
      persistence: 'none',
      message: 'Flow tools are not available in this version.',
    });
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('keeps unavailable non-patch errors as plain text', async () => {
    const result = await dispatch({ name: 'frink_flows_list', mode: 'plan' });

    expect(result?.isError).toBe(true);
    expect(resultText(result)).toBe('Flow tools are not available in plan mode.');
  });

  it('returns a structured no-write result for a patch tool in plan mode', async () => {
    const result = await dispatch({ mode: 'plan' });

    expect(result?.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toEqual({
      status: 'failure',
      persistence: 'none',
      message: 'Flow tools are not available in plan mode.',
    });
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('preserves an explicit deny message in the structured agent-facing result', async () => {
    const message = 'Denied by project rule mcp__frink_dynamic_chat__frink_flows_patch';
    state.validateToolPermission.mockResolvedValue({ allowed: false, message });
    const result = await dispatch();

    expect(result?.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toEqual({
      status: 'failure',
      persistence: 'none',
      permissionDenied: true,
      userMessage: FLOW_PERMISSION_SUMMARIES.blocked,
      message,
    });
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('refuses a write when its captured execution is superseded during permission review', async () => {
    let current = true;
    let resolvePermission: ((decision: { allowed: true }) => void) | undefined;
    state.validateToolPermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    );

    const pending = dispatch({ isExecutionCurrent: () => current });
    await vi.waitFor(() => expect(state.validateToolPermission).toHaveBeenCalledOnce());
    current = false;
    resolvePermission?.({ allowed: true });

    const result = await pending;
    expect(result?.isError).toBe(true);
    expect(resultText(result)).toContain('no longer active');
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('preserves a timeout-style deny message in the structured agent-facing result', async () => {
    const message =
      'Permission request timed out; the user did NOT deny this Flow write. Retry after they respond.';
    state.validateToolPermission.mockResolvedValue({ allowed: false, message });

    const result = await dispatch({ channelAddressed: true });

    expect(result?.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toEqual({
      status: 'failure',
      persistence: 'none',
      // A timeout is nobody's decision — the agent must not read it as a decline.
      permissionDenied: false,
      userMessage: FLOW_PERMISSION_SUMMARIES.timedOut,
      message,
    });
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('pairs a user denial with short user-facing copy without changing the agent message', async () => {
    const message = 'User denied permission';
    state.validateToolPermission.mockResolvedValue({ allowed: false, message });

    const result = await dispatch();

    expect(JSON.parse(resultText(result))).toMatchObject({
      permissionDenied: true,
      userMessage: FLOW_PERMISSION_SUMMARIES.denied,
      message,
    });
  });

  it('fails a stale identity closed with an actionable agent-facing message', async () => {
    const result = await dispatch({ ctx: null, channelAddressed: true });

    expect(result?.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({
      status: 'failure',
      persistence: 'none',
      permissionDenied: false,
      userMessage: FLOW_PERMISSION_SUMMARIES.staleContext,
      message: expect.stringMatching(/context.*no longer active.*Retry.*current turn/i),
    });
    expect(state.validateToolPermission).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('fails a missing project closed with an actionable agent-facing message', async () => {
    const result = await dispatch({ ctx: makeCtx({ projectPath: undefined }) });

    expect(result?.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({
      status: 'failure',
      persistence: 'none',
      permissionDenied: false,
      userMessage: FLOW_PERMISSION_SUMMARIES.missingProject,
      message: expect.stringMatching(/project context.*Open this chat.*retry/i),
    });
    expect(state.validateToolPermission).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('never gates read-only flow tools', async () => {
    state.validateToolPermission.mockResolvedValue({ allowed: false });

    await expect(dispatch({ name: 'frink_flows_list' })).resolves.toBe(FLOW_RESULT);
    expect(state.validateToolPermission).not.toHaveBeenCalled();
  });

  it('dispatches a gate-approved mutating tool with its execution context', async () => {
    await expect(dispatch()).resolves.toBe(FLOW_RESULT);
    expect(state.handleFlowsToolCall).toHaveBeenCalledWith(
      'frink_flows_patch',
      { flowId: 'flow-1' },
      'execution-1',
      '/project',
      // frink_flows_patch edits rather than executes, so it never asks for
      // per-flow consent and carries none.
      { invocationConsented: false },
    );
  });

  it('consumes an exact provider approval without a duplicate Flow permission prompt', async () => {
    await expect(dispatch({ providerPreapproved: true })).resolves.toBe(FLOW_RESULT);
    expect(state.validateToolPermission).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).toHaveBeenCalledOnce();
  });

  it.each(['claude', 'codex'] as const)(
    'authorizes the captured registration snapshot at dynamic dispatch for %s',
    async (runtime) => {
    const args = { packagePath: 'read-colocated-image' };
    const presentation = {
      type: 'custom-node-registration' as const,
      packagePath: args.packagePath,
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
    state.handleFlowsToolCall.mockImplementationOnce(
      async (
        name: string,
        toolArgs: Record<string, JsonValue>,
        executionId: string,
        projectPath: string,
        options: {
          registerNode: {
            chatScoped?: boolean;
            authorize: (value: typeof presentation) => Promise<{ allowed: boolean }>;
            isExecutionCurrent?: () => boolean;
          };
        },
      ) => {
        expect([name, toolArgs, executionId, projectPath]).toEqual([
          'frink_register_node',
          args,
          'execution-1',
          '/project',
        ]);
        expect(options.registerNode.isExecutionCurrent?.()).toBe(true);
        expect(options.registerNode.chatScoped).toBe(true);
        await expect(options.registerNode.authorize(presentation)).resolves.toEqual({
          allowed: true,
        });
        return FLOW_RESULT;
      },
    );

    await expect(
      dispatch({
        name: 'frink_register_node',
        args,
        ctx: makeCtx({ runtime }),
        isExecutionCurrent: () => true,
        providerPreapproved: runtime === 'codex',
      }),
    ).resolves.toBe(FLOW_RESULT);

      expect(state.validateToolPermission).toHaveBeenCalledOnce();
      expect(state.validateToolPermission.mock.calls[0]?.at(-1)).toEqual(presentation);
    },
  );

  it('still refuses a stale execution after an exact provider approval', async () => {
    const result = await dispatch({
      providerPreapproved: true,
      isExecutionCurrent: () => false,
    });
    expect(result?.isError).toBe(true);
    expect(resultText(result)).toContain('no longer active');
    expect(state.validateToolPermission).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('reports a Flow tool that has no dispatcher implementation', async () => {
    state.handleFlowsToolCall.mockResolvedValueOnce(null);

    const result = await dispatch({ name: 'frink_flows_list' });

    expect(result?.isError).toBe(true);
    expect(resultText(result)).toBe('Unhandled flow tool: frink_flows_list');
  });

  it('keeps every user-facing permission summary within the renderer copy limit', () => {
    for (const summary of Object.values(FLOW_PERMISSION_SUMMARIES)) {
      expect(summary.length).toBeLessThanOrEqual(96);
    }
  });
});

describe('gateFlowWrite', () => {
  beforeEach(() => {
    state.validateToolPermission.mockReset();
    state.validateToolPermission.mockResolvedValue({ allowed: true });
  });

  it('with no execution context: allows only an identity-less bare local call', async () => {
    await expect(gateFlowWrite(null, 'frink_flows_patch', {}, validateWrite)).resolves.toEqual({
      allowed: true,
    });
    // A channel whose context is gone is a straggler from an ended turn and must refuse.
    await expect(
      gateFlowWrite(null, 'frink_flows_patch', {}, validateWrite, true),
    ).resolves.toEqual({
      allowed: false,
      message: expect.stringContaining('no longer active'),
    });
    expect(state.validateToolPermission).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'skips re-validation for a Claude run: its SDK callbacks already asked (channel: %s)',
    async (channelAddressed) => {
      const ctx = makeCtx({ runtime: 'claude' });
      await expect(
        gateFlowWrite(ctx, 'frink_flows_patch', {}, validateWrite, channelAddressed),
      ).resolves.toEqual({ allowed: true });
      expect(state.validateToolPermission).not.toHaveBeenCalled();
    },
  );

  it('routes an Auto OFF Codex channel ask through Frink instead of deferring to Codex', async () => {
    const args = { flowId: 'f-auto-off' };

    await expect(
      gateFlowWrite(
        makeCtx({ runtime: 'codex', autoReviewTools: false }),
        'frink_flows_patch',
        args,
        validateWrite,
        true,
      ),
    ).resolves.toEqual({ allowed: true });

    expect(state.validateToolPermission).toHaveBeenCalledWith(
      'mcp__frink_dynamic_chat__frink_flows_patch',
      args,
      '/project',
      'chat-1',
      'sub-1',
      'Flow tool: frink_flows_patch',
      'flow tool: frink_flows_patch',
      false,
      false,
      undefined,
    );
  });

  it('Auto consent defers only the residual: an explicit deny rule still wins', async () => {
    state.validateToolPermission.mockResolvedValueOnce({ allowed: false, message: 'deny rule' });
    await expect(
      gateFlowWrite(
        makeCtx({ runtime: 'codex', autoReviewTools: true }),
        'frink_flows_patch',
        {},
        validateWrite,
        true,
      ),
    ).resolves.toEqual({ allowed: false, message: 'deny rule' });
    expect(state.validateToolPermission).toHaveBeenLastCalledWith(
      expect.any(String),
      {},
      '/project',
      'chat-1',
      'sub-1',
      expect.any(String),
      expect.any(String),
      false,
      true,
      undefined,
    );
  });

  it('binds the permission wait to the captured execution signal', async () => {
    const signal = new AbortController().signal;
    await gateFlowWrite(
      makeCtx({ runtime: 'codex', abortSignal: signal }),
      'frink_flows_patch',
      {},
      validateWrite,
      true,
    );
    expect(state.validateToolPermission).toHaveBeenLastCalledWith(
      expect.any(String),
      {},
      '/project',
      'chat-1',
      'sub-1',
      expect.any(String),
      expect.any(String),
      false,
      false,
      signal,
    );
  });

  it('non-Claude Auto consent resolves a registration ask residual as allow', async () => {
    state.validateToolPermission.mockResolvedValueOnce({ allowed: null });
    await expect(
      gateFlowWrite(
        makeCtx({
          runtime: 'codex',
          autoReviewTools: true,
          planAutoDenyFloor: () => false,
        }),
        'frink_register_node',
        { packagePath: 'read-image' },
        validateWrite,
        true,
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it('fails closed when a registration ask is unresolved during plan Auto review', async () => {
    state.validateToolPermission.mockResolvedValueOnce({ allowed: null });
    await expect(
      gateFlowWrite(
        makeCtx({ autoReviewTools: true, planAutoDenyFloor: () => true }),
        'frink_register_node',
        { packagePath: 'read-image' },
        validateWrite,
        true,
      ),
    ).resolves.toEqual({ allowed: false, message: 'Provider review was not available' });
  });

  it('refuses when the context has no projectPath (Gap A must not widen onto flow writes)', async () => {
    await expect(
      gateFlowWrite(makeCtx({ projectPath: undefined }), 'frink_flows_patch', {}, validateWrite),
    ).resolves.toEqual({
      allowed: false,
      message: expect.stringMatching(/project context.*Open this chat.*retry/i),
    });
    expect(state.validateToolPermission).not.toHaveBeenCalled();
  });

  it('uses the global nodes root for projectless registration permission', async () => {
    const presentation = {
      type: 'custom-node-registration' as const,
      packagePath: 'read-image',
      action: 'create' as const,
      node: { name: 'read-image', entrypoint: 'index.js' },
      source: { current: "console.log('ok');" },
      modules: [],
      resources: [],
      credentialNames: [],
      packageDigest: 'a'.repeat(64),
      packageBytes: 32,
      warning: 'Runs unsandboxed.',
    };

    await expect(
      gateFlowWrite(
        makeCtx({ projectPath: undefined }),
        'frink_register_node',
        { packagePath: 'read-image' },
        validateWrite,
        false,
        presentation,
      ),
    ).resolves.toEqual({ allowed: true });

    expect(state.validateToolPermission.mock.calls[0]?.[2]).toMatch(/\/\.frink\/nodes$/);
  });

  it('maps a dispatcher refusal to a denied gate without losing its message', async () => {
    state.validateToolPermission.mockResolvedValue({
      allowed: false,
      message: 'exact dispatcher denial',
    });
    await expect(gateFlowWrite(makeCtx(), 'frink_flows_patch', {}, validateWrite)).resolves.toEqual(
      { allowed: false, message: 'exact dispatcher denial' },
    );
  });
});

describe('gateFlowInvocation (per-flow agent-run consent)', () => {
  beforeEach(() => {
    state.handleFlowsToolCall.mockReset();
    state.handleFlowsToolCall.mockResolvedValue(FLOW_RESULT);
    state.validateToolPermission.mockReset();
    state.validateToolPermission.mockResolvedValue({ allowed: true });
    state.getFlow.mockReset();
    state.getFlow.mockResolvedValue({
      id: 'flow-1',
      name: 'Nightly digest',
      agent_invocable: false,
      is_enabled: true,
      graph: { nodes: [{ id: 'n1', blockType: 'run_command' }], edges: [] },
    });
    state.updateFlow.mockReset();
    state.updateFlow.mockResolvedValue(undefined);
    state.listFlowBatchStages.mockReset();
    state.listFlowBatchStages.mockResolvedValue({ stages: [{ run_count: 3 }, { run_count: 4 }] });
    state.requestFlowConsent.mockReset();
    state.requestFlowConsent.mockResolvedValue('once');
  });

  it('does not ask when the flow already carries the standing grant', async () => {
    state.getFlow.mockResolvedValue({
      id: 'flow-1',
      name: 'Granted',
      agent_invocable: true,
      is_enabled: true,
    });

    await dispatch({ name: 'frink_flows_run' });

    expect(state.requestFlowConsent).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).toHaveBeenCalledWith(
      'frink_flows_run',
      { flowId: 'flow-1' },
      'execution-1',
      '/project',
      { invocationConsented: false },
    );
  });

  it('never asks for a tool that edits rather than executes a flow', async () => {
    await dispatch({ name: 'frink_flows_patch' });
    expect(state.requestFlowConsent).not.toHaveBeenCalled();
  });

  it('passes a one-call consent to the handler without granting the standing right', async () => {
    state.requestFlowConsent.mockResolvedValue('once');

    await dispatch({ name: 'frink_flows_run' });

    expect(state.handleFlowsToolCall).toHaveBeenCalledWith(
      'frink_flows_run',
      { flowId: 'flow-1' },
      'execution-1',
      '/project',
      { invocationConsented: true },
    );
    expect(state.updateFlow).not.toHaveBeenCalled();
  });

  it('records the standing grant when the user chooses it', async () => {
    state.requestFlowConsent.mockResolvedValue('always');

    await dispatch({ name: 'frink_flows_run' });

    expect(state.updateFlow).toHaveBeenCalledWith('flow-1', { agentInvocable: true });
  });

  it('keeps the standing grant even when the run itself is then refused', async () => {
    // "Always allow this Flow" answers whether an agent may run this flow, not
    // whether this particular run succeeded. A disabled flow or invalid graph
    // must not silently retract the user's decision.
    state.requestFlowConsent.mockResolvedValue('always');
    state.handleFlowsToolCall.mockResolvedValue({
      content: [{ type: 'text', text: 'Flow is disabled.' }],
      isError: true,
    });

    await dispatch({ name: 'frink_flows_run' });

    expect(state.updateFlow).toHaveBeenCalledWith('flow-1', { agentInvocable: true });
  });

  it('keeps the standing grant when the turn ends while the card is open', async () => {
    // The run is correctly refused as stale, but the grant the user clicked is
    // durable intent and must outlive the turn that asked for it.
    state.requestFlowConsent.mockImplementation(async () => {
      live = false;
      return 'always';
    });
    let live = true;

    const result = await dispatch({
      name: 'frink_flows_run',
      isExecutionCurrent: () => live,
    });

    expect(resultText(result)).toContain('no longer active');
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
    expect(state.updateFlow).toHaveBeenCalledWith('flow-1', { agentInvocable: true });
  });

  it('leaves no standing grant behind for a batch that activated nothing', async () => {
    // start_batch reports "no pending root stages" as a SUCCESSFUL result, so
    // the grant must come from the user's click, not from the result shape.
    state.requestFlowConsent.mockResolvedValue('once');
    state.handleFlowsToolCall.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true, started: false }) }],
      isError: false,
    });

    await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-1' },
    });

    expect(state.updateFlow).not.toHaveBeenCalled();
  });

  it('blocks the tool when the user declines', async () => {
    state.requestFlowConsent.mockResolvedValue('denied');

    const result = await dispatch({ name: 'frink_flows_run' });

    expect(resultText(result)).toContain('declined');
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('distinguishes an expired card from a refusal the user never made', async () => {
    state.requestFlowConsent.mockResolvedValue('expired');

    const result = await dispatch({ name: 'frink_flows_run' });

    expect(resultText(result)).toContain('expired');
    expect(resultText(result)).toContain('Nobody declined');
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('refuses a batch that grew after the card quoted its size', async () => {
    // add_stage_runs can enlarge a pending batch while the card is open, and
    // dispatch reads stages fresh — so approving "7 runs" could start far more.
    state.listFlowBatchStages
      .mockResolvedValueOnce({ stages: [{ run_count: 3 }, { run_count: 4 }] })
      .mockResolvedValueOnce({ stages: [{ run_count: 100 }, { run_count: 100 }] });
    state.requestFlowConsent.mockResolvedValue('once');

    const result = await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-1' },
    });

    expect(resultText(result)).toContain('grew after the user was asked');
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
    expect(JSON.parse(resultText(result)).permissionDenied).toBe(false);
  });

  it('runs a batch that did not change while the card was open', async () => {
    state.listFlowBatchStages.mockResolvedValue({ stages: [{ run_count: 3 }, { run_count: 4 }] });
    state.requestFlowConsent.mockResolvedValue('once');

    await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-1' },
    });

    expect(state.handleFlowsToolCall).toHaveBeenCalled();
  });

  it('allows a batch that shrank while the card was open', async () => {
    // Fewer runs than approved is within what the user agreed to.
    state.listFlowBatchStages
      .mockResolvedValueOnce({ stages: [{ run_count: 3 }, { run_count: 4 }] })
      .mockResolvedValueOnce({ stages: [{ run_count: 1 }] });
    state.requestFlowConsent.mockResolvedValue('once');

    await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-1' },
    });

    expect(state.handleFlowsToolCall).toHaveBeenCalled();
  });

  it('tells the card how much work a batch approval authorises', async () => {
    await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-1' },
    });

    expect(state.requestFlowConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ batch: { stageCount: 2, pendingRunCount: 7 } }),
      }),
    );
  });

  it('flags unsandboxed steps so the name alone is not what is approved', async () => {
    await dispatch({ name: 'frink_flows_run' });

    expect(state.requestFlowConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowName: 'Nightly digest',
        summary: expect.objectContaining({ unsandboxedBlockTypes: ['run_command'] }),
      }),
    );
  });

  it('offers only the standing grant on a Flow-driven Auto turn without blocking', async () => {
    let settle: (decision: string) => void = () => {};
    state.requestFlowConsent.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve as (decision: string) => void;
        }),
    );

    const result = await dispatch({
      name: 'frink_flows_run',
      ctx: makeCtx({ autoReviewTools: true, isFlowDrivenTurn: true }),
    });

    // Returned while the card is still unanswered — an unattended run must not
    // park on it for the permission timeout.
    expect(resultText(result)).toContain('approval is waiting');
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
    expect(state.requestFlowConsent).toHaveBeenCalledWith(
      expect.objectContaining({ allowOnce: false }),
    );

    // A click after the turn moved on still records the grant, so a later run works.
    settle('always');
    await vi.waitFor(() =>
      expect(state.updateFlow).toHaveBeenCalledWith('flow-1', { agentInvocable: true }),
    );
  });

  it('waits for the click in a person-driven Auto chat, then runs the flow', async () => {
    // Auto is on by default, so an Auto chat usually has the user right there.
    // Returning "pending" would strand their click with no run behind it.
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('once'), 5)),
    );

    const result = await dispatch({
      name: 'frink_flows_run',
      ctx: makeCtx({ autoReviewTools: true }),
    });

    expect(state.requestFlowConsent).toHaveBeenCalledWith(
      expect.objectContaining({ allowOnce: true }),
    );
    expect(result).toBe(FLOW_RESULT);
  });

  it('tells the superseded caller its approval was used, not refused', async () => {
    // "Permission was not approved. Nothing changed." would be doubly wrong
    // here: the user DID approve, and the flow DID run via the sibling call.
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('once'), 5)),
    );

    const results = await Promise.all([
      dispatch({ name: 'frink_flows_run' }),
      dispatch({ name: 'frink_flows_run' }),
    ]);
    const superseded = results.find((r) => r?.isError);

    const body = JSON.parse(resultText(superseded ?? null));
    expect(body.permissionDenied).toBe(false);
    expect(body.userMessage).toBe(FLOW_PERMISSION_SUMMARIES.consentSuperseded);
  });

  it('starts exactly one run when two concurrent calls share one "Allow once"', async () => {
    // The dedup that stops two cards stacking must not hand the same one-call
    // grant to both callers — that would turn one click into two executions.
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('once'), 5)),
    );

    await Promise.all([
      dispatch({ name: 'frink_flows_run' }),
      dispatch({ name: 'frink_flows_run' }),
    ]);

    const consented = state.handleFlowsToolCall.mock.calls.filter(
      (c: unknown[]) => (c[4] as { invocationConsented?: boolean })?.invocationConsented,
    );
    expect(state.requestFlowConsent).toHaveBeenCalledTimes(1);
    expect(consented).toHaveLength(1);
  });

  it('raises a separate card for a differently-scoped action on the same flow', async () => {
    // A single run and a 200-run batch are different asks. Collapsing them onto
    // one card would let a click approving the summary the user SAW authorize
    // the action they never saw.
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('once'), 5)),
    );

    await Promise.all([
      dispatch({ name: 'frink_flows_run' }),
      dispatch({
        name: 'frink_flows_start_batch',
        args: { flowId: 'flow-1', batchId: 'batch-1' },
      }),
    ]);

    expect(state.requestFlowConsent).toHaveBeenCalledTimes(2);
  });

  it('raises a separate card per batch on the same flow', async () => {
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('once'), 5)),
    );

    await Promise.all([
      dispatch({
        name: 'frink_flows_start_batch',
        args: { flowId: 'flow-1', batchId: 'batch-a' },
      }),
      dispatch({
        name: 'frink_flows_start_batch',
        args: { flowId: 'flow-1', batchId: 'batch-b' },
      }),
    ]);

    expect(state.requestFlowConsent).toHaveBeenCalledTimes(2);
  });

  it('reports a refusal that nobody made as not-declined', async () => {
    // The agent's guidance keys "do not retry" off permissionDenied, so a
    // pending, expired, superseded or undeliverable card must not claim one.
    for (const [decision, expected] of [
      ['denied', true],
      ['expired', false],
    ] as const) {
      state.requestFlowConsent.mockReset();
      state.requestFlowConsent.mockResolvedValue(decision);

      const result = await dispatch({ name: 'frink_flows_run' });

      expect(JSON.parse(resultText(result)).permissionDenied).toBe(expected);
    }
  });

  it('does not claim a decline when the consent card could not be raised', async () => {
    state.requestFlowConsent.mockRejectedValue(new Error('socket disconnected'));

    const result = await dispatch({ name: 'frink_flows_run' });

    expect(JSON.parse(resultText(result)).permissionDenied).toBe(false);
  });

  it('does not claim a decline while an unattended card is still waiting', async () => {
    let settle: (d: string) => void = () => {};
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as (d: string) => void)),
    );

    const result = await dispatch({
      name: 'frink_flows_run',
      ctx: makeCtx({ autoReviewTools: true, isFlowDrivenTurn: true, subChatId: 'sub-pending' }),
    });

    expect(JSON.parse(resultText(result)).permissionDenied).toBe(false);
    settle('denied');
  });

  it('does not let an interactive call inherit an open unattended card', async () => {
    // An unattended card is detached and offers no "Allow once". If a later
    // interactive call joined it, that turn would hang on a card its own abort
    // cannot dismiss, and the user would never see the one-call button.
    let settle: (d: string) => void = () => {};
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as (d: string) => void)),
    );

    await dispatch({
      name: 'frink_flows_run',
      ctx: makeCtx({ autoReviewTools: true, isFlowDrivenTurn: true, subChatId: 'sub-mixed' }),
    });
    void dispatch({ name: 'frink_flows_run', ctx: makeCtx({ subChatId: 'sub-mixed' }) });
    await vi.waitFor(() => expect(state.requestFlowConsent).toHaveBeenCalledTimes(2));

    const [auto, interactive] = state.requestFlowConsent.mock.calls;
    expect(auto[0].allowOnce).toBe(false);
    expect(interactive[0].allowOnce).toBe(true);
    settle('denied');
  });

  it('joins one unattended card across parked retries in the same sub-chat', async () => {
    // The agent parks and retries under a NEW execution. Keying the card on the
    // turn would stack a duplicate prompt on every retry.
    let settle: (d: string) => void = () => {};
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as (d: string) => void)),
    );
    const auto = makeCtx({
      autoReviewTools: true,
      isFlowDrivenTurn: true,
      subChatId: 'sub-parked',
    });

    await dispatch({ name: 'frink_flows_run', ctx: auto });
    await dispatchFlowToolCall({
      name: 'frink_flows_run',
      args: { flowId: 'flow-1' },
      executionId: 'execution-retry',
      ctx: auto,
      projectPath: '/project',
      mode: 'agent',
      flowsEnabled: true,
      validateWrite,
      requestFlowConsent: (...a: unknown[]) => state.requestFlowConsent(...a),
      flowStore,
    });

    expect(state.requestFlowConsent).toHaveBeenCalledTimes(1);
    settle('denied');
  });

  it('collapses concurrent calls for one flow onto a single card', async () => {
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('once'), 5)),
    );

    await Promise.all([
      dispatch({ name: 'frink_flows_run' }),
      dispatch({ name: 'frink_flows_run' }),
    ]);

    expect(state.requestFlowConsent).toHaveBeenCalledTimes(1);
  });

  it('does not start a run when the turn ended while the card was open', async () => {
    let live = true;
    state.requestFlowConsent.mockImplementation(async () => {
      live = false;
      return 'once';
    });

    const result = await dispatch({
      name: 'frink_flows_run',
      isExecutionCurrent: () => live,
    });

    expect(resultText(result)).toContain('no longer active');
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('falls through to the handler when there is no chat to ask in', async () => {
    const result = await dispatch({ name: 'frink_flows_run', requestFlowConsent: null });

    expect(state.requestFlowConsent).not.toHaveBeenCalled();
    // The handler applies the terminal agent_invocable check itself.
    expect(state.handleFlowsToolCall).toHaveBeenCalledWith(
      'frink_flows_run',
      { flowId: 'flow-1' },
      'execution-1',
      '/project',
      { invocationConsented: false },
    );
    expect(result).toBe(FLOW_RESULT);
  });
  it('returns a tool error instead of rejecting when the consent card itself fails', async () => {
    // A socket drop or executor throw must surface as a Flow tool result the
    // agent can read. Letting it reject rejects the whole MCP tool call.
    state.requestFlowConsent.mockRejectedValue(new Error('socket disconnected'));

    const result = await dispatch({ name: 'frink_flows_run' });

    expect(result?.isError).toBe(true);
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });

  it('still raises the flow card on the Claude runtime, where the tool gate short-circuits', async () => {
    // gateFlowWrite passes Claude straight through (the SDK PreToolUse hook
    // already ruled the TOOL). Resource-level consent is a different question
    // and must still be asked, or Claude users silently skip it.
    await dispatch({ name: 'frink_flows_run', ctx: makeCtx({ runtime: 'claude' }) });

    expect(state.requestFlowConsent).toHaveBeenCalledTimes(1);
    expect(state.validateToolPermission).not.toHaveBeenCalled();
  });

  it('raises one card per pane when two chats run the same flow at once', async () => {
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('once'), 5)),
    );

    await Promise.all([
      dispatchFlowToolCall({
        name: 'frink_flows_run',
        args: { flowId: 'flow-1' },
        executionId: 'execution-pane-a',
        ctx: makeCtx({ subChatId: 'sub-a' }),
        projectPath: '/project',
        mode: 'agent',
        flowsEnabled: true,
        validateWrite,
        requestFlowConsent: (...a: unknown[]) => state.requestFlowConsent(...a),
        flowStore,
      }),
      dispatchFlowToolCall({
        name: 'frink_flows_run',
        args: { flowId: 'flow-1' },
        executionId: 'execution-pane-b',
        ctx: makeCtx({ subChatId: 'sub-b' }),
        projectPath: '/project',
        mode: 'agent',
        flowsEnabled: true,
        validateWrite,
        requestFlowConsent: (...a: unknown[]) => state.requestFlowConsent(...a),
        flowStore,
      }),
    ]);

    // One pane's answer must not silently rule the other's run.
    expect(state.requestFlowConsent).toHaveBeenCalledTimes(2);
  });

  it('does not report an infrastructure failure as a user decline', async () => {
    // The agent's guidance reads permissionDenied: true as "the user declined,
    // do not retry". A permission-store outage is nobody's decision.
    state.validateToolPermission.mockResolvedValue({
      allowed: false,
      message: 'Permission database is unavailable; cannot evaluate request',
    });

    const result = await dispatch({ name: 'frink_flows_run' });

    expect(JSON.parse(resultText(result)).permissionDenied).toBe(false);
  });

  it('still reports a rule denial as a decline, since the user wrote the rule', async () => {
    state.validateToolPermission.mockResolvedValue({
      allowed: false,
      message: 'Denied by project rule mcp__frink_dynamic_chat__frink_flows_run',
    });

    const result = await dispatch({ name: 'frink_flows_run' });

    expect(JSON.parse(resultText(result)).permissionDenied).toBe(true);
  });

  it('keeps the batch frozen while an Auto card is still open', async () => {
    // The Auto call returns immediately, but the card is still quoting a size —
    // releasing the hold now would let add_stage_runs grow it undisclosed.
    let settle: (d: string) => void = () => {};
    state.requestFlowConsent.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as (d: string) => void)),
    );
    const { isBatchAwaitingConsent } = await import('./flow-invocation-consent');

    await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-auto' },
      ctx: makeCtx({ autoReviewTools: true, isFlowDrivenTurn: true, subChatId: 'sub-auto-hold' }),
    });

    expect(isBatchAwaitingConsent('batch-auto')).toBe(true);

    settle('denied');
    await vi.waitFor(() => expect(isBatchAwaitingConsent('batch-auto')).toBe(false));
  });

  it('releases the batch hold when the turn dies before dispatch', async () => {
    // A stranded hold would refuse every later add_stage_runs on that batch.
    state.requestFlowConsent.mockResolvedValue('once');
    let live = true;
    state.handleFlowsToolCall.mockImplementation(() => {
      live = false;
      return Promise.resolve(FLOW_RESULT);
    });

    await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-held' },
      isExecutionCurrent: () => live,
    });

    const { isBatchAwaitingConsent } = await import('./flow-invocation-consent');
    expect(isBatchAwaitingConsent('batch-held')).toBe(false);
  });

  it('refuses a batch whose size cannot be read rather than asking blind', async () => {
    // Losing the count loses BOTH protections: the card can no longer state
    // what it authorises, and the batch is no longer held against growth.
    state.listFlowBatchStages.mockRejectedValue(new Error('db locked'));

    const result = await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-1' },
    });

    expect(state.requestFlowConsent).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
    expect(JSON.parse(resultText(result)).permissionDenied).toBe(false);
  });

  it('counts staged runs across stages, treating a missing count as zero', async () => {
    state.listFlowBatchStages.mockResolvedValue({
      stages: [{ run_count: 5 }, { run_count: undefined }, { run_count: 2 }],
    });

    await dispatch({
      name: 'frink_flows_start_batch',
      args: { flowId: 'flow-1', batchId: 'batch-1' },
    });

    expect(state.requestFlowConsent.mock.calls[0][0].summary.batch).toEqual({
      stageCount: 3,
      pendingRunCount: 7,
    });
  });

  it('does not fail a started run when recording the standing grant fails', async () => {
    state.requestFlowConsent.mockResolvedValue('always');
    state.updateFlow.mockRejectedValue(new Error('db locked'));

    const result = await dispatch({ name: 'frink_flows_run' });

    // The run already started; a bookkeeping failure must not report it failed.
    expect(result).toBe(FLOW_RESULT);
  });

  it('records nothing when an unattended card is declined', async () => {
    state.requestFlowConsent.mockResolvedValue('denied');

    await dispatch({
      name: 'frink_flows_run',
      ctx: makeCtx({ autoReviewTools: true, isFlowDrivenTurn: true }),
    });
    await vi.waitFor(() => expect(state.requestFlowConsent).toHaveBeenCalled());

    expect(state.updateFlow).not.toHaveBeenCalled();
    expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
  });
});
