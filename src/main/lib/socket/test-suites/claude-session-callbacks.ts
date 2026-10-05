import { randomUUID } from 'node:crypto';
import type { SDKBackgroundTasksChangedMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTaskById } from '../../db/repos/tasks';
import * as dynamicChatServer from '../../mcp/dynamic-chat-server';
import { checkPermission } from '../../permissions/v2/check';
import {
  type ClaudeSession,
  createSession,
  endSession,
  getSession,
} from '../claude-session-registry';
import { createClaudeTurnContext } from '../claude-turn-context';
import * as socketClient from '../client';
import { drainPendingPermissions } from '../executor';
import {
  noteSubagentTaskFrame,
  setBackgroundRosterPublisher,
} from '../streaming/subagent-task-status';
import { getPreToolUseHook } from '../test-utils';
import {
  expireQuestion,
  flowDriven,
  mcpMounted,
  pinTask,
  runningTask,
  type SessionOptions,
  stopInput,
  TURN_END,
  toolCall,
} from './claude-turn-bindings';
import { UNCLEAN_RESULT } from './claude-turn-abort';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type ClaudeSessionCallbackHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & { claudeQueryMock: ReturnType<typeof vi.fn> };

let payload: ClaudeSessionCallbackHarness['basePayload'];
/** An error result is never kept idle, so the ended session's turn stays attached. */
const UNKEPT_TURN_END = [TURN_END[0], UNCLEAN_RESULT];
const todoWrite = { hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: {} };
const mcpShip = { hook_event_name: 'PreToolUse', tool_name: 'mcp__deploy__ship', tool_input: {} };
const exitPlanMode = { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} };
// SAFETY: the seam consumes only decision/prompt; this is the dispatcher's ask shape.
const ASK = { decision: 'ask', prompt: { reason: 'no-matching-rule' } } as Awaited<
  ReturnType<typeof checkPermission>
>;

/** Registers the cases proving a session's callbacks act only for the turn attached to the session
 * they were spawned for: none attached denies tools, and a successor's turn is never theirs. */
export function registerClaudeSessionCallbackTests(harness: ClaudeSessionCallbackHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;

  describe('Claude session callbacks', () => {
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
      vi.mocked(getTaskById).mockImplementation(async (_db, id) => runningTask(id));
    });

    it('with no turn attached, a session denies tools and lets Stop end', async () => {
      const decisions: unknown[] = [];
      // A task chat, so an attached turn with no signal yet would block its Stop.
      mcpMounted(true);
      pinTask('task-idle');
      claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
        const session = getSession(payload.subChatId);
        const attached = session?.currentTurn ?? null;
        if (session) session.currentTurn = null;
        decisions.push(
          await getPreToolUseHook(input)(todoWrite, 'tool-1'),
          await input.options.canUseTool('TodoWrite', {}, toolCall('tool-2')),
          await input.options.hooks.Stop[0].hooks[0](stopInput()),
        );
        if (session) session.currentTurn = attached;
        yield* TURN_END;
      });

      await handleRemoteExecute({ ...payload, message: 'do the work' });

      expect(decisions).toEqual([
        { hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) },
        { behavior: 'deny', message: expect.stringContaining('No turn is active') },
        {},
      ]);
    });

    itGatesRosterVerdictOnLiveSession(harness);
    itStopsOnFreshPostPlanPark(harness);

    // sc-2771: the signal target check must see the task the flow DRIVES; the pinned first-node
    // task is terminal, so checking it would refuse every later node's live `done`.
    it.each([
      ['the driving flow task, not the pinned one', true, 'task-flow'],
      ['the pinned task when no flow drives the chat', false, 'task-pinned'],
    ])('registers %s as the context signal target', async (_name, driven, expected) => {
      pinTask('task-pinned');
      if (driven) flowDriven();
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield* UNKEPT_TURN_END;
      });

      await handleRemoteExecute({ ...payload, message: 'ship it' });

      const calls = vi.mocked(dynamicChatServer.setCurrentExecutionChat).mock.calls;
      expect(calls.at(-1)?.[12]).toBe(expected);
    });

    // sc-1357: the CLI re-enters canUseTool after a hook allow (settings ask rules); a card there
    // would time out as a user refusal, so only PreToolUse, whose reason survives, prompts.
    it('an MCP ask prompts once, in PreToolUse; canUseTool re-checks rules but never prompts', async () => {
      const decisions: unknown[] = [];
      vi.mocked(checkPermission).mockResolvedValue(ASK);
      vi.mocked(socketClient.sendPermissionRequest).mockClear();
      // Every card expires unanswered: drain settles pending requests exactly as a timeout does.
      vi.mocked(socketClient.sendPermissionRequest).mockImplementation(() =>
        queueMicrotask(drainPendingPermissions),
      );
      claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
        decisions.push(
          await getPreToolUseHook(input)(mcpShip, 'tool-1'),
          await input.options.canUseTool('mcp__deploy__ship', {}, toolCall('tool-1')),
        );
        yield* UNKEPT_TURN_END;
      });

      try {
        await handleRemoteExecute({ ...payload, message: 'ship it' });
        // The hook's card is the only one: a second request would come from canUseTool.
        expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce();
      } finally {
        // clearAllMocks keeps implementations; later suites must not inherit the auto-timeout.
        vi.mocked(socketClient.sendPermissionRequest).mockReset();
      }

      expect(decisions).toEqual([
        {
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('the user did NOT deny it'),
          }),
        },
        { behavior: 'allow', updatedInput: {} },
      ]);
    });

    it('canUseTool still enforces an MCP deny rule', async () => {
      let decision: unknown;
      vi.mocked(checkPermission).mockResolvedValueOnce({
        decision: 'deny',
        reason: { kind: 'rule:deny', rule: 'mcp__deploy__ship', tier: 'user' },
      });
      claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
        decision = await input.options.canUseTool('mcp__deploy__ship', {}, toolCall('tool-1'));
        yield* UNKEPT_TURN_END;
      });

      await handleRemoteExecute({ ...payload, message: 'ship it' });

      expect(decision).toEqual({ behavior: 'deny', message: expect.any(String) });
    });

    it("a session's callbacks act for it, never a successor under the same chat id", async () => {
      let options: SessionOptions | undefined;
      claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
        options = input.options;
        yield* UNKEPT_TURN_END;
      });
      await handleRemoteExecute({ ...payload, message: 'first' });
      if (!options) throw new Error('the first execute never spawned a CLI');

      // The successor's turn is halted on a submitted plan, which would deny every tool.
      const successor = createSession(payload.subChatId, () => ({}) as never);
      const halted = createClaudeTurnContext();
      halted.planSubmissionHalt = () => true;
      successor.currentTurn = halted;
      try {
        expect([
          await getPreToolUseHook({ options })(todoWrite, 'tool-1'),
          await options.canUseTool('TodoWrite', {}, toolCall('tool-2')),
        ]).toEqual([{}, { behavior: 'allow', updatedInput: {} }]);
        expect(halted.deniedToolIdsWithMessages.size).toBe(0);
      } finally {
        endSession(payload.subChatId);
      }
    });

    it('an expired question ends the session that asked, never a successor under the same chat id', async () => {
      let options: SessionOptions | undefined;
      let asking: ClaudeSession | undefined;
      claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
        options = input.options;
        asking = getSession(payload.subChatId);
        yield* UNKEPT_TURN_END;
      });
      await handleRemoteExecute({ ...payload, message: 'first' });
      if (!options || !asking) throw new Error('the first execute never spawned a CLI');

      const successor = createSession(payload.subChatId, () => ({ return: vi.fn() }) as never);
      const killed = () => ({
        asking: asking?.interruptExpected,
        successor: successor.interruptExpected,
      });
      try {
        expireQuestion(options.canUseTool);
        await vi.waitFor(() => expect(Object.values(killed())).toContain(true));
        expect(killed()).toEqual({ asking: true, successor: false });
        expect(getSession(payload.subChatId)).toBe(successor);
      } finally {
        endSession(payload.subChatId);
      }
    });
  });
}

/** A late Stop from a draining or ended session shares its successor's sub-chat key, so its
 * dead-follower verdict must not reach the roster. */
function itGatesRosterVerdictOnLiveSession(harness: ClaudeSessionCallbackHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;
  it('applies a Stop’s dead-follower verdict only while its session is live, not draining or ended', async () => {
    const publishRoster = vi.fn();
    setBackgroundRosterPublisher(publishRoster);
    const follower = {
      id: 'tail1',
      type: 'shell',
      status: 'running',
      description: '',
      command: 'tail -f /tmp/x/sess1/tasks/ship9.output',
    };
    const stopWith = { ...stopInput([follower]), session_id: 'sess1' };
    const changed: SDKBackgroundTasksChangedMessage = {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'tail1', task_type: 'local_bash', description: 'follow' }],
      uuid: randomUUID(),
      session_id: 'sess1',
    };
    const published: unknown[] = [];
    claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
      const session = getSession(payload.subChatId);
      const stop = input.options.hooks.Stop[0].hooks[0];
      noteSubagentTaskFrame(payload.subChatId, changed);
      publishRoster.mockClear();
      if (session) session.loop.closeExpected = true;
      await stop(stopWith);
      if (session) Object.assign(session.loop, { closeExpected: false, stopped: true });
      await stop(stopWith);
      published.push(publishRoster.mock.calls.length);
      if (session) session.loop.stopped = false;
      await stop(stopWith);
      published.push(publishRoster.mock.lastCall?.[0]);
      yield* UNKEPT_TURN_END;
    });

    await handleRemoteExecute({ ...payload, message: 'watch the ship' });
    setBackgroundRosterPublisher(null);

    expect(published).toEqual([0, { subChatId: payload.subChatId, tasks: [] }]);
  });
}

/** An auto-approve plan node that parked while drafting may still park genuinely after its plan;
 * chasing that second park pushed agents to flip a correct pause into `blocked`. */
function itStopsOnFreshPostPlanPark(harness: ClaudeSessionCallbackHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;
  it('a turn past its plan is chased off its drafting park but stops on a fresh one', async () => {
    const decisions: unknown[] = [];
    const draftingPark = { state: 'awaiting_input' as const, summary: 'Which API?', at: 'now' };
    const latestSignal = vi.mocked(dynamicChatServer.getLatestTaskSignal);
    mcpMounted(true);
    pinTask('task-plan-node');
    claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
      const stop = input.options.hooks.Stop[0].hooks[0];
      const turn = getSession(payload.subChatId)?.currentTurn;
      if (!turn) throw new Error('no turn attached');
      // Drafting on an auto-approve node, parked: the real PreToolUse path snapshots the park.
      turn.planTerminalsLocked = true;
      turn.execution = { ...turn.execution, flowPlanAutoApprove: true };
      latestSignal.mockReturnValue(draftingPark);
      await getPreToolUseHook(input)(exitPlanMode, 'exit-1');
      // The executor's ExitPlanMode completion on an auto-approve node: unlock, mark submitted.
      turn.planTerminalsLocked = false;
      turn.planSubmitted = true;
      decisions.push((await stop(stopInput())).decision);
      // Same `at` on purpose: only identity tells the two parks apart.
      latestSignal.mockReturnValue({ ...draftingPark, summary: 'Need the push branch' });
      decisions.push((await stop(stopInput())).decision);
      yield* UNKEPT_TURN_END;
    });

    try {
      await handleRemoteExecute({ ...payload, message: 'implement the plan' });
    } finally {
      latestSignal.mockReset();
    }

    expect(decisions).toEqual(['block', undefined]);
  });
}
