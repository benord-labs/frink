import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTaskById } from '../../db/repos/tasks';
import {
  type ClaudeSession,
  createSession,
  endSession,
  getSession,
} from '../claude-session-registry';
import { createClaudeTurnContext } from '../claude-turn-context';
import { getPreToolUseHook } from '../test-utils';
import {
  expireQuestion,
  mcpMounted,
  pinTask,
  runningTask,
  type SessionOptions,
  stopInput,
  TURN_END,
  toolCall,
} from './claude-turn-bindings';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type ClaudeSessionCallbackHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & { claudeQueryMock: ReturnType<typeof vi.fn> };

let payload: ClaudeSessionCallbackHarness['basePayload'];
/** An error result is never kept idle, so the ended session's turn stays attached. */
const UNKEPT_TURN_END = [TURN_END[0], { type: 'result', is_error: true }];
const todoWrite = { hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: {} };

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
