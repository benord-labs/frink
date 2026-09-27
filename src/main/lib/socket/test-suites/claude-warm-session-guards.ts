import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSessionsForTest, retireRetainedSessions } from '../claude-session-registry';
import { hasWakeHold, releaseWakeHold } from '../claude-wake-hold';
import * as socketClient from '../client';
import { abortActiveExecutionsForSubChats } from '../executor';
import * as runtimeGate from '../runtime-gate';
import { mockQuery, never } from './claude-turn-abort';
import { flowDriven, RUNNING_TASK, TURN_END } from './claude-turn-bindings';
import { answeringCli } from './claude-warm-session';
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
const replies = () =>
  vi
    .mocked(socketClient.sendStreamChunkDirect)
    .mock.calls.map(([sent]) => (sent.chunk as { delta?: string }).delta)
    .filter(Boolean);

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

    it('Ultra spawns with the ultracode setting, and toggling it applies live on the same CLI', async () => {
      const first = mockQuery(claudeQueryMock, answeringCli());
      const spawned = (call: number) => claudeQueryMock.mock.calls[call]?.[0]?.options;

      await send('first', { settings: { effort: 'xhigh', ultra: true } });
      await send('second', { sessionId: 'sess-held', settings: { effort: 'xhigh' } });

      expect(spawned(0)?.settings).toEqual({ ultracode: true });
      expect(sessionLines('claim')).toEqual(['miss:none', 'hit']);
      expect(claudeQueryMock).toHaveBeenCalledTimes(1);
      // Ultra is cleared before the effort is set: clearing it alone leaves the CLI at xhigh.
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
