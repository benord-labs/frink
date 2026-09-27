import { randomUUID } from 'node:crypto';
import type {
  BackgroundTaskSummary,
  CanUseTool,
  StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultClaudeCodeToken } from '../../credentials';
import { getChatWithProjectAccount } from '../../db/repos/chats';
import { getFlowDriveInfoForSubChat, getTaskById } from '../../db/repos/tasks';
import * as dynamicChatServer from '../../mcp/dynamic-chat-server';
import { getMultiProjectContext } from '../../multi-project-prompt';
import { PERMISSION_PROMPT_TIMEOUT_MS } from '../../permissions/constants';
import { checkPermission } from '../../permissions/v2/check';
import { captureMainMessage } from '../../sentry/init';
import type { TaskStopHook } from '../../task-stop-hook';
import { getSession } from '../claude-session-registry';
import { hasWakeHold, releaseWakeHold } from '../claude-wake-hold';
import * as socketClient from '../client';
import { getActiveExecution } from '../streaming/execution-registry';
import { getPreToolUseHook, type PreToolUseQueryInput, stopHookQuery } from '../test-utils';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type ClaudeTurnBindingHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'clientPermissionBridge' | 'handleRemoteExecute'
> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};

export type SessionOptions = NonNullable<PreToolUseQueryInput['options']> & {
  hooks: { Stop: Array<{ hooks: TaskStopHook[] }> };
  canUseTool: CanUseTool;
};
type StopDecision = Awaited<ReturnType<TaskStopHook>>;
type Turn = {
  options: SessionOptions;
  stop: (backgroundTasks?: BackgroundTaskSummary[]) => Promise<StopDecision>;
};

export const RUNNING_TASK: BackgroundTaskSummary = {
  id: 'bg1',
  type: 'shell',
  status: 'running',
  description: 'coverage run',
};
export const stopInput = (backgroundTasks: BackgroundTaskSummary[] = []): StopHookInput => ({
  hook_event_name: 'Stop',
  stop_hook_active: false,
  background_tasks: backgroundTasks,
  session_id: '',
  transcript_path: '',
  cwd: '',
});
export const toolCall = (toolUseID: string) => ({
  toolUseID,
  signal: new AbortController().signal,
});
/** Asks one AskUserQuestion and lets it expire. Only its own timer is faked, so the park can't stall. */
export function expireQuestion(canUseTool: CanUseTool): void {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  void canUseTool(
    'AskUserQuestion',
    { questions: [{ question: 'Which env?', header: 'Env', options: [], multiSelect: false }] },
    toolCall('ask-1'),
  );
  vi.advanceTimersByTime(PERMISSION_PROMPT_TIMEOUT_MS);
  vi.useRealTimers();
}
export const TURN_END = [
  { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-held' } }] },
  { type: 'result' },
];
export const mcpMounted = (mounted: boolean) =>
  vi.mocked(getMultiProjectContext).mockResolvedValueOnce({
    promptPrefix: '',
    dynamicChatMcpUrl: mounted ? 'http://127.0.0.1:9/mcp' : null,
  });
export const runningTask = (id: string) =>
  // SAFETY: task signal arming reads only id, status, result and flowRunId from this row.
  ({ id, status: 'running', result: {}, flowRunId: null }) as Awaited<
    ReturnType<typeof getTaskById>
  >;
/** Pins the next execute's chat to `taskId`; every task reads as running (the suite's beforeEach). */
export const pinTask = (taskId: string) =>
  vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce(
    // SAFETY: the executor reads only chat worktree/branch/taskId and the account off this row.
    { chat: { taskId }, account: null } as Awaited<ReturnType<typeof getChatWithProjectAccount>>,
  );
/** The next execute is driven by a flow on `task-flow`. */
export const flowDriven = () =>
  vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
    active: true,
    autoApprovePlan: false,
    taskId: 'task-flow',
  });
/** The running case's payload, on a sub-chat of its own (the suite's beforeEach). */
let payload: ClaudeTurnBindingHarness['basePayload'];
const readExecution = () => {
  const record = getActiveExecution(payload.subChatId);
  return { epoch: record?.streamEpoch, controller: record?.controller };
};

const heldFlagSettings = vi.fn(async (_settings: object) => {});

/** One session: turn 1 leaves background work running so the chat holds, then `adopted` runs inside
 * the follow-up turn that takes the hold over. `onTakeover` runs as that turn prepares its push. */
function mockHeldSession(
  claudeQueryMock: ClaudeTurnBindingHarness['claudeQueryMock'],
  adopted: (turn: Turn) => Promise<void>,
  { onArming, onTakeover }: { onArming?: () => void; onTakeover?: () => void } = {},
): void {
  claudeQueryMock.mockImplementationOnce(
    (input: { prompt: AsyncIterable<unknown>; options: SessionOptions }) => {
      const prompt = input.prompt[Symbol.asyncIterator]();
      const stop = (backgroundTasks: BackgroundTaskSummary[] = []) =>
        input.options.hooks.Stop[0].hooks[0](stopInput(backgroundTasks));
      const gen = (async function* () {
        await prompt.next();
        onArming?.();
        await stop([RUNNING_TASK]);
        yield* TURN_END;
        if ((await prompt.next()).done) return;
        await adopted({ options: input.options, stop });
        yield* TURN_END;
        await prompt.next(); // open until the session's stdin closes
      })();
      return Object.assign(gen, {
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn(async () => onTakeover?.()),
        setModel: vi.fn(async () => {}),
        applyFlagSettings: heldFlagSettings,
      });
    },
  );
}

/** The arming execute holds on background work; the follow-up execute adopts the held session. */
async function armThenFollowUp(
  { handleRemoteExecute }: ClaudeTurnBindingHarness,
  arm = () => {},
  followUp = () => {},
): Promise<void> {
  vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
  arm();
  await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
  expect(hasWakeHold(payload.subChatId)).toBe(true);
  followUp();
  await handleRemoteExecute({
    ...payload,
    assistantMessageId: 'msg-adopting',
    message: 'follow-up while coverage runs',
  });
}

/** Registers the cases proving a Claude session's callbacks act for the turn running on it, which is
 * not always the execute that spawned it: a follow-up adopts a session held on background work. */
export function registerClaudeTurnBindingTests(harness: ClaudeTurnBindingHarness): void {
  describe('Claude turn bindings', () => {
    // Isolated rather than drained: a case's un-awaited tail (a hold unwinding, a parked question)
    // runs on its own sub-chat and reads tasks by id, so it cannot reach or consume the next case's.
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
      vi.mocked(getTaskById).mockImplementation(async (_db, id) => runningTask(id));
    });
    afterEach(() => {
      releaseWakeHold(payload.subChatId, 'test cleanup');
      // Only execute-start reads are fed per execute (mock*Once); a failed case must not leave any.
      for (const mock of [
        getMultiProjectContext,
        getChatWithProjectAccount,
        getFlowDriveInfoForSubChat,
        dynamicChatServer.setCurrentExecutionChat,
        dynamicChatServer.getLatestTaskSignal,
        dynamicChatServer.bindChannelExecution,
      ]) {
        vi.mocked(mock).mockReset();
      }
    });
    registerAdoptedCallbackTests(harness);
    registerStopHookTests(harness);
  });
}

function registerAdoptedCallbackTests(harness: ClaudeTurnBindingHarness): void {
  const { claudeQueryMock } = harness;

  it('an adopted follow-up off Ultra clears the held session ultracode', async () => {
    heldFlagSettings.mockClear();
    mockHeldSession(claudeQueryMock, async () => {});
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    await harness.handleRemoteExecute({
      ...payload,
      message: 'fan out and wait',
      settings: { effort: 'xhigh', ultra: true },
    });
    expect(hasWakeHold(payload.subChatId)).toBe(true);
    await harness.handleRemoteExecute({ ...payload, message: 'follow-up on High' });

    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(heldFlagSettings.mock.calls).toEqual([[{ ultracode: null }], [{ effortLevel: null }]]);
  });

  it('an adopted turn records frink_task_signal on its own task', async () => {
    let signalled: unknown[] = [];
    mockHeldSession(claudeQueryMock, async ({ options }) => {
      vi.mocked(getTaskById).mockClear();
      await options.canUseTool(
        'mcp__frink_dynamic_chat__frink_task_signal',
        { state: 'done', summary: 'coverage green' },
        toolCall('signal-1'),
      );
      signalled = vi.mocked(getTaskById).mock.calls.map(([, taskId]) => taskId);
    });

    const taskChat = (taskId: string) => () => {
      mcpMounted(true);
      pinTask(taskId);
    };
    await armThenFollowUp(harness, taskChat('task-arming'), taskChat('task-adopting'));

    expect(signalled).toEqual(['task-adopting']);
  });

  it("an adopted turn's question streams under its own epoch and parks through its own controller", async () => {
    const arming: Partial<ReturnType<typeof readExecution>> = {};
    const adopting: typeof arming = {};
    mockHeldSession(
      claudeQueryMock,
      async ({ options }) => {
        Object.assign(adopting, readExecution());
        expireQuestion(options.canUseTool);
      },
      { onArming: () => Object.assign(arming, readExecution()) },
    );

    await armThenFollowUp(harness, () => {}, flowDriven);
    await vi.waitFor(() => expect(adopting.controller?.signal.aborted).toBe(true));

    expect(adopting.epoch).not.toBe(arming.epoch);
    expect(socketClient.sendStreamChunkDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        chunk: expect.objectContaining({ type: 'ask-user-question' }),
        streamEpoch: adopting.epoch,
      }),
    );
    expect(arming.controller?.signal.aborted).toBe(false);
  });

  it("an adopted flow turn's permission prompt knows it is unattended", async () => {
    let decision: unknown;
    mockHeldSession(claudeQueryMock, async ({ options }) => {
      // SAFETY: the seam consumes only decision/prompt; this is the dispatcher's ask shape.
      vi.mocked(checkPermission).mockResolvedValueOnce({
        decision: 'ask',
        prompt: { reason: 'no-matching-rule' },
      } as Awaited<ReturnType<typeof checkPermission>>);
      vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((request) => {
        harness.clientPermissionBridge.lastResponseHandler?.({
          chatId: request.chatId,
          subChatId: request.subChatId,
          requestId: request.requestId,
          approved: false,
          timedOut: true,
        });
      });
      decision = await getPreToolUseHook({ options })(
        { hook_event_name: 'PreToolUse', tool_name: 'mcp__deploy__ship', tool_input: {} },
        'tool-1',
      );
    });

    await armThenFollowUp(harness, () => {}, flowDriven);

    expect(decision).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason: expect.stringContaining('automated flow run'),
      },
    });
    expect(captureMainMessage).toHaveBeenCalledWith('Permission prompt timed out', 'warning', {
      flowDriven: 'true',
    });
  });

  it("binds the MCP channel to each turn's own context: fresh before it runs, adopted at its push", async () => {
    const bound = () =>
      vi.mocked(dynamicChatServer.bindChannelExecution).mock.calls.map(([, id]) => id);
    const seen: Array<Array<string | undefined>> = [];
    mockHeldSession(claudeQueryMock, async () => {}, {
      onArming: () => seen.push(bound()),
      onTakeover: () => seen.push(bound()),
    });
    vi.mocked(dynamicChatServer.setCurrentExecutionChat)
      .mockReturnValueOnce('ctx-arming')
      .mockReturnValueOnce('ctx-adopting');

    await armThenFollowUp(harness);

    expect(seen).toEqual([['ctx-arming'], ['ctx-arming', 'ctx-adopting']]);
    await vi.waitFor(() =>
      expect(dynamicChatServer.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-arming'),
    );
  });

  it('a follow-up stopped before its takeover push releases its own execution context', async () => {
    // Stop lands while the follow-up prepares its takeover, before the push.
    mockHeldSession(claudeQueryMock, async () => {}, {
      onTakeover: () => getActiveExecution(payload.subChatId)?.controller.abort(),
    });
    vi.mocked(dynamicChatServer.setCurrentExecutionChat)
      .mockReturnValueOnce('ctx-arming')
      .mockReturnValueOnce('ctx-adopting');

    await armThenFollowUp(harness);

    expect(dynamicChatServer.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-adopting');
  });
}

function registerStopHookTests(harness: ClaudeTurnBindingHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;

  it.each([
    ['blocks when the held session mounted the tool and this turn has a task', true, true, true],
    ['never blocks a turn with no task, even on a task-armed session', true, false, false],
    ['never blocks when the held session has no tool to signal with', false, true, false],
  ])('adopted Stop: %s', async (_name, heldMounted, ownTask, blocks) => {
    let decision: unknown;
    mockHeldSession(claudeQueryMock, async ({ stop }) => {
      decision = await stop();
    });

    await armThenFollowUp(
      harness,
      () => {
        mcpMounted(heldMounted);
        pinTask('task-arming');
      },
      () => {
        // Opposite of the held mount: an adopted turn keeps the tool its session was spawned with.
        mcpMounted(!heldMounted);
        if (ownTask) pinTask('task-adopting');
      },
    );

    if (blocks) expect(decision).toMatchObject({ decision: 'block' });
    else expect(decision).toEqual({});
  });

  it('an adopted turn that leaves work running re-arms from the session hook', async () => {
    mockHeldSession(claudeQueryMock, async ({ stop }) => {
      await stop([RUNNING_TASK]);
    });

    await armThenFollowUp(harness);

    // Its last publication follows the takeover's retraction, so a held one is the re-arm.
    const published = vi.mocked(socketClient.sendWakeHoldChanged).mock.calls.map(([p]) => p);
    expect(published.filter((p) => p.subChatId === payload.subChatId).at(-1)).toMatchObject({
      held: true,
    });
  });

  it.each([
    ['a plain chat never blocks', false, ['allow', 'allow', 'allow']],
    ['a task chat blocks until its signal lands', true, ['block', 'allow']],
  ])('fresh Stop: %s', async (_name, taskChat, expected) => {
    const decisions: StopDecision[] = [];
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    if (taskChat) {
      mcpMounted(true);
      pinTask('task-fresh');
    }
    claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
      const stop = input.options.hooks.Stop[0].hooks[0];
      for (const _ of expected) {
        decisions.push(await stop(stopInput()));
        // The agent signals after its first stop.
        vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue({
          state: 'done',
          summary: 'finished',
          at: new Date().toISOString(),
        });
      }
      yield* TURN_END;
    });

    await handleRemoteExecute({ ...payload, message: 'do the work' });

    expect(decisions.map((d) => d.decision ?? 'allow')).toEqual(expected);
  });

  it('an adoption retried on a fresh session signals and stops under its own execution', async () => {
    const decisions: StopDecision[] = [];
    let signalled: unknown[] = [];
    mockHeldSession(claudeQueryMock, async () => {
      // A rotated api key reruns at once; a transient error would first wait out a real backoff.
      const credential = await getDefaultClaudeCodeToken();
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
        ...credential,
        token: 'rotated',
      });
      throw new Error('Failed to authenticate. API Error: 401');
    });
    claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
      const stop = input.options.hooks.Stop[0].hooks[0];
      decisions.push(await stop(stopInput()));
      vi.mocked(getTaskById).mockClear();
      await input.options.canUseTool(
        'mcp__frink_dynamic_chat__frink_task_signal',
        { state: 'done', summary: 'coverage green' },
        toolCall('signal-1'),
      );
      signalled = vi.mocked(getTaskById).mock.calls.map(([, taskId]) => taskId);
      vi.mocked(dynamicChatServer.getLatestTaskSignal).mockImplementation((contextId) =>
        contextId === 'ctx-adopting'
          ? { state: 'done', summary: 'coverage green', at: new Date().toISOString() }
          : undefined,
      );
      decisions.push(await stop(stopInput()));
      yield* TURN_END;
    });
    vi.mocked(dynamicChatServer.setCurrentExecutionChat)
      .mockReturnValueOnce('ctx-arming')
      .mockReturnValueOnce('ctx-adopting');

    // The held session has no signal tool; the follow-up mounts one and has a task to signal.
    await armThenFollowUp(
      harness,
      () => mcpMounted(false),
      () => {
        mcpMounted(true);
        pinTask('task-adopting');
      },
    );

    // Ordered so a failure names its case: the rerun threw, never ran, or ran on the wrong execution.
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
    expect(decisions.map((d) => d.decision ?? 'allow')).toEqual(['block', 'allow']);
    expect(signalled).toEqual(['task-adopting']);
  });

  it('a follow-up landing in the pump-death window falls back to a fresh session without error', async () => {
    const { subChatId } = payload;
    mcpMounted(true);
    pinTask('task-wake-toctou');
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    const query = stopHookQuery({
      sessionId: 'sess-wake-hold',
      backgroundTasks: [RUNNING_TASK],
      wakeText: 'coverage finished — proceeding',
      interrupt: vi.fn().mockResolvedValue(undefined),
    });
    claudeQueryMock.mockImplementationOnce(query.impl);

    await handleRemoteExecute({ ...payload, message: 'run coverage and wait' });
    expect(hasWakeHold(subChatId)).toBe(true);

    // The CLI dies; poll microtasks until the pump has exited but before its deferred cleanup
    // necessarily ran — the window where a user follow-up meets a dead-but-registered hold.
    query.endStream();
    for (let i = 0; i < 50 && getSession(subChatId)?.busy; i++) {
      await Promise.resolve();
    }

    pinTask('task-wake-toctou');
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'text-delta', id: 'fresh', delta: 'fresh reply' }] };
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-fresh' } }] };
      yield { type: 'result' };
    });
    await handleRemoteExecute({
      ...payload,
      assistantMessageId: 'msg-follow-up-fresh',
      message: 'follow up after the pump died',
    });

    expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
    expect(socketClient.sendStreamChunkDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessageId: 'msg-follow-up-fresh',
        chunk: expect.objectContaining({ type: 'text-delta' }),
      }),
    );
  });
}
