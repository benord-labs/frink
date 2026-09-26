import { afterEach, describe, expect, it, vi } from 'vitest';

/** Registers Flow dispatch cases against the parent server test harness. */

type DynamicChatModule = typeof import('../dynamic-chat-server');
type ExecutionIdentityModule = typeof import('../execution-identity');
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
type Mock = ReturnType<typeof vi.fn>;

type FlowDispatchState = {
  consumeCodexMcpApproval: Mock;
  handleFlowsToolCall: Mock;
  validateToolPermission: Mock;
  resetFlowsAddStageRunsCount: Mock;
  resetFlowsRunCount: Mock;
  resetFlowsPatchCount: Mock;
  resetFlowsGetRunCount: Mock;
  resetFlowsGetBatchCount: Mock;
  resetFlowsListTemplatesCount: Mock;
  resetFlowsPatchCreateCount: Mock;
  resetRegisterNodeCount: Mock;
};

type FlowDispatchHarness = {
  state: FlowDispatchState;
  callDynamicChatToolByName: DynamicChatModule['callDynamicChatToolByName'];
  callToolOverHttp: (
    name: string,
    args: Record<string, unknown>,
    channel?: string,
    meta?: Record<string, unknown>,
  ) => Promise<ToolResult>;
  getChannelToken: ExecutionIdentityModule['getChannelToken'];
  setCurrentExecutionChat: DynamicChatModule['setCurrentExecutionChat'];
  clearCurrentExecutionChat: DynamicChatModule['clearCurrentExecutionChat'];
};

const FLOW_RATE_LIMIT_RESET_KEYS = [
  'resetFlowsAddStageRunsCount',
  'resetFlowsRunCount',
  'resetFlowsPatchCount',
  'resetFlowsGetRunCount',
  'resetFlowsGetBatchCount',
  'resetFlowsListTemplatesCount',
  'resetFlowsPatchCreateCount',
  'resetRegisterNodeCount',
] as const satisfies ReadonlyArray<keyof FlowDispatchState>;

function expectFlowRateLimitsReset(
  state: FlowDispatchState,
  executionId: string | undefined,
): void {
  for (const key of FLOW_RATE_LIMIT_RESET_KEYS) {
    expect(state[key]).toHaveBeenCalledWith(executionId);
  }
}

export function registerDynamicChatFlowDispatchTests({
  state,
  callDynamicChatToolByName,
  callToolOverHttp,
  getChannelToken,
  setCurrentExecutionChat,
  clearCurrentExecutionChat,
}: FlowDispatchHarness): void {
  describe('flows tool dispatch', () => {
    afterEach(() => {
      clearCurrentExecutionChat();
      vi.clearAllMocks();
    });

    it('dispatches frink_flows_list to handleFlowsToolCall with the session project path', async () => {
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/proj', 'agent');
      const result = await callDynamicChatToolByName('frink_flows_list', {}, executionId);
      expect(result.isError).toBe(false);
      expect(state.handleFlowsToolCall).toHaveBeenCalledWith(
        'frink_flows_list',
        {},
        executionId,
        '/proj',
      );
      clearCurrentExecutionChat(executionId);
    });

    it.each([
      false,
      true,
    ])('uses one exact Codex provider decision and one transport call with Auto=%s', async (autoReview) => {
      setCurrentExecutionChat(
        'chat-1',
        'sub-1',
        '/proj',
        'agent',
        undefined,
        undefined,
        undefined,
        'codex',
        autoReview,
      );
      state.consumeCodexMcpApproval.mockReturnValueOnce(true);
      const args = { name: 'provider-approved', operations: [] };

      const result = await callToolOverHttp(
        'frink_flows_patch',
        args,
        getChannelToken('sub-1', 'codex'),
        { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' },
      );

      expect(result.isError).toBe(false);
      expect(state.consumeCodexMcpApproval).toHaveBeenCalledWith(
        'thread-1',
        'turn-1',
        'call-1',
        'frink_dynamic_chat',
        'frink_flows_patch',
        args,
      );
      expect(state.validateToolPermission).not.toHaveBeenCalled();
      expect(state.handleFlowsToolCall).toHaveBeenCalledOnce();
    });

    it('binds a channel write to its captured signal and refuses it after abort', async () => {
      const controller = new AbortController();
      setCurrentExecutionChat(
        'chat-1',
        'sub-1',
        '/proj',
        'agent',
        undefined,
        undefined,
        undefined,
        'codex',
        false,
        false,
        controller.signal,
      );
      let allow: ((decision: { allowed: true }) => void) | undefined;
      state.validateToolPermission.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            allow = resolve;
          }),
      );

      const pending = callToolOverHttp(
        'frink_flows_patch',
        { name: 'stale-flow', operations: [] },
        getChannelToken('sub-1', 'codex'),
      );
      await vi.waitFor(() => expect(state.validateToolPermission).toHaveBeenCalledOnce());
      expect(state.validateToolPermission.mock.calls[0]?.at(-1)).toBe(controller.signal);
      controller.abort();
      if (!allow) throw new Error('Expected deferred permission validation');
      allow({ allowed: true });

      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('no longer active');
      expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
    });

    it('refuses a channel write whose execution is superseded during permission review', async () => {
      const codexRun = () =>
        setCurrentExecutionChat(
          'chat-1',
          'sub-1',
          '/proj',
          'agent',
          undefined,
          undefined,
          undefined,
          'codex',
        );
      codexRun();
      let allow: ((decision: { allowed: true }) => void) | undefined;
      state.validateToolPermission.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            allow = resolve;
          }),
      );

      const pending = callToolOverHttp(
        'frink_flows_patch',
        { name: 'old-flow', operations: [] },
        getChannelToken('sub-1', 'codex'),
      );
      await vi.waitFor(() => expect(state.validateToolPermission).toHaveBeenCalledOnce());
      codexRun();
      if (!allow) throw new Error('Expected deferred permission validation');
      allow({ allowed: true });

      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('no longer active');
      expect(state.handleFlowsToolCall).not.toHaveBeenCalled();
    });

    it('calls flow rate-limit resets on clearCurrentExecutionChat', () => {
      const executionId = setCurrentExecutionChat('chat-1', 'sub-1', '/proj', 'agent');
      clearCurrentExecutionChat(executionId);
      expectFlowRateLimitsReset(state, executionId);
    });

    it('calls flow rate-limit resets with no arg when clearing all executions', () => {
      state.resetFlowsAddStageRunsCount.mockClear();
      state.resetFlowsRunCount.mockClear();
      state.resetFlowsPatchCount.mockClear();
      state.resetFlowsGetRunCount.mockClear();
      state.resetFlowsGetBatchCount.mockClear();
      state.resetFlowsListTemplatesCount.mockClear();
      state.resetFlowsPatchCreateCount.mockClear();
      state.resetRegisterNodeCount.mockClear();
      setCurrentExecutionChat('chat-1', 'sub-1', '/proj', 'agent');
      clearCurrentExecutionChat();
      expect(state.resetFlowsAddStageRunsCount).toHaveBeenCalledTimes(1);
      expectFlowRateLimitsReset(state, undefined);
    });
  });
}
