import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookRegistration } from '../../../../shared/types/hook-inventory';
import { getTaskById } from '../../db/repos/tasks';
import * as dynamicChatServer from '../../mcp/dynamic-chat-server';
import { checkPermission } from '../../permissions/v2/check';
import {
  type ClaudeSession,
  createSession,
  endSession,
  getSession,
} from '../claude-session-registry';
import { type ClaudeTurnContext, createClaudeTurnContext } from '../claude-turn-context';
import * as socketClient from '../client';
import { drainPendingPermissions } from '../executor';
import {
  noteSubagentTaskFrame,
  setBackgroundRosterPublisher,
} from '../streaming/subagent-task-status';
import { getPreToolUseHook, type PreToolUseHook } from '../test-utils';
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

type ToolCallInput = Parameters<PreToolUseHook>[0];
type ClaudeSessionCallbackHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & { claudeQueryMock: ReturnType<typeof vi.fn> };

let payload: ClaudeSessionCallbackHarness['basePayload'];
/** An error result is never kept idle, so the ended session's turn stays attached. */
const UNKEPT_TURN_END = [TURN_END[0], UNCLEAN_RESULT];
const todoWrite = { hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: {} };
const mcpShip = { hook_event_name: 'PreToolUse', tool_name: 'mcp__deploy__ship', tool_input: {} };
// SAFETY: the seam consumes only decision/prompt; this is the dispatcher's ask shape.
const ASK = { decision: 'ask', prompt: { reason: 'no-matching-rule' } } as Awaited<
  ReturnType<typeof checkPermission>
>;

const planInput = (text: string) => ({ planFilePath: '/mock/home/.claude/plans/p.md', plan: text });

/** Binds a hook that rewrites the plan to "new", calls the gate with plan "old", and returns the
 * gate's decision with the plan the turn submitted for review. */
async function submitRewrittenPlan(
  turn: ClaudeTurnContext,
  // The shared hook type omits the SDK's signal argument, which bound hooks need.
  gate: (...call: [ToolCallInput, string, { signal: AbortSignal }]) => ReturnType<PreToolUseHook>,
) {
  const output = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: planInput('new') },
  };
  const hook: HookRegistration = {
    id: 'h',
    scope: 'project',
    file: '/f',
    event: 'PreToolUse',
    label: 'h',
    handlerType: 'command',
    command: `printf '%s' '${JSON.stringify(output)}'`,
    binding: { status: 'supported', ignored: [] },
  };
  const context = { cwd: '/tmp', sessionCwd: '/tmp', projectRoot: '/tmp', env: {} };
  turn.execution.userHooks = { hooks: [hook], context };
  turn.planTerminalsLocked = true;
  const call = {
    hook_event_name: 'PreToolUse',
    tool_name: 'ExitPlanMode',
    tool_input: planInput('old'),
  };
  const answer = await gate(call, 'tool-1', { signal: new AbortController().signal });
  return {
    decision: answer.hookSpecificOutput?.permissionDecision,
    plan: turn.submittedPlan?.text,
  };
}

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

    it("starts a turn with none of the user's hooks bound, and only Frink's own callbacks", async () => {
      const seen = vi.fn();
      claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
        const turn = getSession(payload.subChatId)?.currentTurn;
        if (!turn) throw new Error('no turn is attached');
        seen({
          bound: turn.execution.userHooks,
          events: Object.keys(input.options.hooks),
          gates: input.options.hooks.PreToolUse?.length,
        });
        yield* UNKEPT_TURN_END;
      });

      await handleRemoteExecute({ ...payload, message: 'do the work' });

      expect(seen).toHaveBeenCalledExactlyOnceWith({
        bound: undefined,
        events: ['PreToolUse', 'Stop', 'UserPromptSubmit'],
        gates: 2,
      });
    });

    it('submits for review the plan a hook rewrote', async () => {
      let submitted: unknown;
      claudeQueryMock.mockImplementationOnce(async function* (input: { options: SessionOptions }) {
        const turn = getSession(payload.subChatId)?.currentTurn;
        if (!turn) throw new Error('no turn is attached');
        submitted = await submitRewrittenPlan(turn, getPreToolUseHook(input));
        yield* UNKEPT_TURN_END;
      });

      await handleRemoteExecute({ ...payload, message: 'plan it' });

      expect(submitted).toEqual({ decision: 'deny', plan: 'new' });
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
    const changed = {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'tail1', task_type: 'local_bash', description: 'follow' }],
    } as unknown as Parameters<typeof noteSubagentTaskFrame>[1];
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
