import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeVersionSupportsUltra } from '../../claude';
import { getClaudeCodeTokenById } from '../../credentials';
import { getChatWithProjectAccount } from '../../db/repos/chats';
import { getMultiProjectContext } from '../../multi-project-prompt';
import {
  __resetSessionsForTest,
  getSession,
  retireRetainedSessions,
} from '../claude-session-registry';
import { hasWakeHold, releaseWakeHold } from '../claude-wake-hold';
import * as socketClient from '../client';
import { abortActiveExecutionsForSubChats } from '../executor';
import * as runtimeGate from '../runtime-gate';
import { mockQuery, never } from './claude-turn-abort';
import { flowDriven, RUNNING_TASK, TURN_END } from './claude-turn-bindings';
import { answeringCli, replies } from './claude-warm-session';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type WarmSessionGuardHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & { claudeQueryMock: ReturnType<typeof vi.fn> };
type Payload = Parameters<WarmSessionGuardHarness['handleRemoteExecute']>[0];

let payload: WarmSessionGuardHarness['basePayload'];

/** This chat's `[Claude Session]` lines of one kind, e.g. `claim` → `hit` / `miss:<reason>`. */
const sessionLines = (kind: 'claim' | 'retire') =>
  vi
    .mocked(log.info)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith(`[Claude Session] ${kind} sub=${payload.subChatId} `))
    .map((line) => line.split(' ').at(-1));

type PreToolUse = (input: object, toolUseId: string) => Promise<object>;
/** A plan turn as the CLI plays it: the model calls ExitPlanMode, which its PreToolUse hook sees. */
const submitPlan = async (options: object) => {
  const hooks = (options as { hooks: { PreToolUse: Array<{ hooks: PreToolUse[] }> } }).hooks;
  const tool = { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} };
  return hooks.PreToolUse[0].hooks[0](tool, 'exit-plan-1');
};
const exitPlanCall = {
  chunks: [
    {
      type: 'tool-input-available',
      toolCallId: 'exit-plan-1',
      toolName: 'ExitPlanMode',
      input: {},
    },
  ],
};

/** Registers the cases proving a warm Claude session runs a turn under the same guards as a
 * freshly spawned one: the runtime slot, the permission-mode reconcile and credential sweeps. */
export function registerClaudeWarmSessionGuardTests(harness: WarmSessionGuardHarness): void {
  const { claudeQueryMock } = harness;
  const send = (message: string, overrides: Partial<Payload> = {}) =>
    harness.handleRemoteExecute({ ...payload, message, ...overrides });

  describe('warm Claude session guards', () => {
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
    });
    afterEach(() => {
      releaseWakeHold(payload.subChatId, 'test cleanup');
      __resetSessionsForTest();
    });
    registerPlanApprovalReuseTests(claudeQueryMock, send);

    it('Ultra spawns with the ultracode setting at any effort, and toggling it applies live', async () => {
      const first = mockQuery(claudeQueryMock, answeringCli());
      const spawned = (call: number) => claudeQueryMock.mock.calls[call]?.[0]?.options;

      await send('first', { settings: { effort: 'low', ultra: true } });
      await send('second', { sessionId: 'sess-held', settings: { effort: 'xhigh' } });

      expect(spawned(0)?.settings).toEqual({ ultracode: true });
      expect(spawned(0)?.settingSources).toEqual(['project', 'user', 'local']);
      expect(sessionLines('claim')).toEqual(['miss:none', 'hit']);
      expect(claudeQueryMock).toHaveBeenCalledTimes(1);
      expect(first.applyFlagSettings.mock.calls).toEqual([
        [{ ultracode: null }],
        [{ effortLevel: 'xhigh' }],
      ]);
    });

    it('a changed model and effort run on the same CLI, set live before the push', async () => {
      const warm = mockQuery(claudeQueryMock, answeringCli());

      await send('first');
      await send('second', { sessionId: 'sess-held', settings: { model: 'opus', effort: 'low' } });

      expect(sessionLines('claim')).toEqual(['miss:none', 'hit']);
      expect(claudeQueryMock).toHaveBeenCalledTimes(1);
      expect(warm.setModel).toHaveBeenLastCalledWith(expect.stringContaining('opus'));
      expect(warm.applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'low' });
    });

    it('a flow-driven turn never spawns Ultra', async () => {
      mockQuery(claudeQueryMock, answeringCli());
      flowDriven();
      await send('flow turn', { settings: { effort: 'xhigh', ultra: true } });
      expect(claudeQueryMock.mock.calls[0]?.[0]?.options.effort).toBe('xhigh');
      expect(claudeQueryMock.mock.calls[0]?.[0]?.options.settings).toBeUndefined();
    });

    it('a bundled CLI too old for Ultra at any effort never spawns or live-applies it', async () => {
      const warm = mockQuery(claudeQueryMock, answeringCli());
      vi.mocked(claudeVersionSupportsUltra).mockReturnValue(false);
      await send('first', { settings: { effort: 'low', ultra: true } });
      await send('second', { sessionId: 'sess-held', settings: { effort: 'low', ultra: true } });
      vi.mocked(claudeVersionSupportsUltra).mockReturnValue(true);
      expect(claudeQueryMock.mock.calls[0]?.[0]?.options.settings).toBeUndefined();
      expect(warm.applyFlagSettings).not.toHaveBeenCalledWith({ ultracode: true });
    });

    it('a warm-hit turn holds a Claude runtime slot until its settle, as a spawned turn does', async () => {
      mockQuery(claudeQueryMock, answeringCli());
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      const acquire = vi.spyOn(runtimeGate, 'acquireRuntimeSlot').mockImplementation(async () => {
        const release = vi.fn();
        releases.push(release);
        return release;
      });
      try {
        await send('first');
        await send('second', { sessionId: 'sess-held' });

        expect(sessionLines('claim')).toEqual(['miss:none', 'hit']);
        expect(acquire.mock.calls).toEqual([['claude'], ['claude']]);
        for (const release of releases) expect(release).toHaveBeenCalledOnce();
      } finally {
        acquire.mockRestore();
      }
    });

    // Session files live in the sub-chat's own config dir, so no login owns the transcript.
    it('a swap to another Claude login respawns under it, resuming the same session', async () => {
      const first = mockQuery(claudeQueryMock, answeringCli());
      mockQuery(claudeQueryMock, answeringCli());
      const spawned = (call: number) => claudeQueryMock.mock.calls[call]?.[0]?.options;
      await send('first');
      vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
        chat: {},
        account: { id: 'claude-work', label: 'Work' },
      } as never);
      vi.mocked(getClaudeCodeTokenById).mockResolvedValueOnce({
        token: 'sk-ant-api03-work',
        isApiKey: true,
        type: 'claude-code',
        label: 'Work',
      });

      await send('second', { sessionId: 'sess-held' });

      expect(sessionLines('claim')).toEqual(['miss:none', 'miss:key-mismatch:credential']);
      expect(first.close).toHaveBeenCalledOnce();
      expect(spawned(1)?.resume).toBe('sess-held');
      expect(spawned(1)?.env.CLAUDE_CONFIG_DIR).toBe(spawned(0)?.env.CLAUDE_CONFIG_DIR);
    });

    it('a refused permission-mode reconcile retires the claimed CLI and reruns on a fresh one', async () => {
      const warm = mockQuery(claudeQueryMock, answeringCli());
      mockQuery(claudeQueryMock, answeringCli());
      await send('first');
      warm.setPermissionMode.mockRejectedValueOnce(new Error('setter refused'));

      await send('second', { sessionId: 'sess-held' });

      expect(sessionLines('retire')).toEqual(['reason=setter-rejected']);
      expect(warm.close).toHaveBeenCalledOnce();
      expect(claudeQueryMock).toHaveBeenCalledTimes(2);
      expect(replies()).toEqual(['reply 1', 'reply 1']);
      expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
    });

    it('a claimed CLI that starts a turn of its own mid-reconcile is retired once, for that', async () => {
      let ownTurn = () => {};
      const warm = mockQuery(claudeQueryMock, async function* ({ prompt }) {
        await prompt.next();
        yield* TURN_END;
        await new Promise<void>((resolve) => (ownTurn = resolve));
        yield { type: 'assistant' };
        await never();
      });
      mockQuery(claudeQueryMock, answeringCli());
      await send('first');
      const closeStream = warm.close.getMockImplementation();
      // Like the SDK's Query, closing it rejects the pending control request.
      warm.setPermissionMode.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            warm.close.mockImplementationOnce(() => {
              reject(new Error('Query closed before response received'));
              closeStream?.();
            });
            ownTurn();
          }),
      );

      await send('second', { sessionId: 'sess-held' });

      expect(sessionLines('retire')).toEqual(['reason=idle-activity']);
      expect(warm.close).toHaveBeenCalledOnce();
      expect(replies()).toEqual(['reply 1']);
    });

    it('a reconcile refused because the turn was aborted is no setter rejection', async () => {
      const warm = mockQuery(claudeQueryMock, answeringCli());
      await send('first');
      let refuse: (err: Error) => void = () => {};
      warm.setPermissionMode.mockImplementationOnce(
        () => new Promise((_, reject) => void (refuse = reject)),
      );
      const claimed = send('second', { sessionId: 'sess-held' });
      await vi.waitFor(() => expect(warm.setPermissionMode).toHaveBeenCalled());

      abortActiveExecutionsForSubChats([payload.subChatId], 'chat deleted');
      refuse(new Error('query closed'));
      await claimed;

      expect(sessionLines('retire')).toEqual([]);
      expect(warm.close).toHaveBeenCalledOnce();
    });

    it('a follow-up adopts a held CLI a sweep skipped, which retires when that turn ends', async () => {
      const held = mockQuery(claudeQueryMock, async function* ({ prompt, stop }) {
        await prompt.next();
        await stop([RUNNING_TASK]);
        yield* TURN_END;
        if ((await prompt.next()).done) return;
        yield { chunks: [{ type: 'text-delta', id: 'h', delta: 'held reply' }] };
        await stop();
        yield* TURN_END;
        await never();
      });
      await send('run coverage and wait');
      expect(hasWakeHold(payload.subChatId)).toBe(true);

      retireRetainedSessions('credential-change');
      await send('follow-up', { sessionId: 'sess-held' });

      expect(claudeQueryMock).toHaveBeenCalledOnce();
      expect(replies()).toEqual(['held reply']);
      expect(sessionLines('retire')).toEqual(['reason=credential-change']);
      expect(held.close).toHaveBeenCalledOnce();
    });
  });
}

/** A submitted plan's CLI is kept for its approval, unless background work is still running. */
function registerPlanApprovalReuseTests(
  claudeQueryMock: WarmSessionGuardHarness['claudeQueryMock'],
  send: (message: string, overrides?: Partial<Payload>) => Promise<void>,
): void {
  it('approving a submitted plan runs on the CLI that drafted it', async () => {
    let submission: object = {};
    const warm = mockQuery(claudeQueryMock, async function* ({ prompt, options }) {
      await prompt.next();
      yield exitPlanCall;
      submission = await submitPlan(options);
      yield* TURN_END;
      await prompt.next();
      yield { chunks: [{ type: 'text-delta', id: 'impl', delta: 'implementing' }] };
      yield* TURN_END;
      await never();
    });
    const mcp = { promptPrefix: '', dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp' };
    vi.mocked(getMultiProjectContext).mockResolvedValueOnce(mcp).mockResolvedValueOnce(mcp);

    await send('plan it', { mode: 'plan' });
    await send('approved', { sessionId: 'sess-held' });

    // Submission denies ExitPlanMode, so the CLI stays in plan mode until the approval's switch.
    expect(submission).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(sessionLines('claim')).toEqual(['miss:none', 'hit']);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(warm.interrupt).not.toHaveBeenCalled();
    expect(warm.setPermissionMode).toHaveBeenLastCalledWith('default');
    expect(replies()).toContain('implementing');
  });

  it('a submitted plan with background work still running is not kept', async () => {
    mockQuery(claudeQueryMock, async function* ({ prompt, options, stop }) {
      await prompt.next();
      yield exitPlanCall;
      await submitPlan(options);
      await stop([RUNNING_TASK]);
      yield* TURN_END;
      await never();
    });

    await send('plan it', { mode: 'plan' });

    expect(hasWakeHold(payload.subChatId)).toBe(false);
    expect(getSession(payload.subChatId)).toBeUndefined();
  });
}
