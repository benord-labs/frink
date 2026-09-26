import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { runCodexAgent } from '../../agent-runner';
import { getDefaultClaudeCodeToken } from '../../credentials';
import { getMultiProjectContext } from '../../multi-project-prompt';
import { createSession, getSession, retainSession } from '../claude-session-registry';
import * as socketClient from '../client';
import { runTurn } from '../execution/claude-session-loop';
import { abortActiveExecutionsForSubChats } from '../executor';
import { mockQuery, never } from './claude-turn-abort';
import { TURN_END } from './claude-turn-bindings';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type ClaudeSessionTeardownHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & { claudeQueryMock: ReturnType<typeof vi.fn> };

let payload: ClaudeSessionTeardownHarness['basePayload'];

/** A registered session idling between turns, as warm reuse leaves one. */
function idleSession(subChatId: string) {
  const close = vi.fn();
  const next = () => new Promise(() => {});
  const session = createSession(subChatId, () => ({ close, next }) as unknown as Query);
  retainSession(session);
  return { session, close };
}

/** A CLI that answers one prompt and then idles. */
const oneTurn = async function* ({ prompt }: { prompt: AsyncIterator<SDKUserMessage> }) {
  await prompt.next();
  yield { chunks: [{ type: 'text-delta', id: 't', delta: 'done' }] };
  yield* TURN_END;
  await never();
};

/** Registers the cases proving every teardown site retires an idle Claude session, and that a
 * spawn never shares a session a sibling execute registered first. */
export function registerClaudeSessionTeardownTests(harness: ClaudeSessionTeardownHarness): void {
  const { claudeQueryMock, handleRemoteExecute } = harness;

  describe('Claude session teardown', () => {
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
    });

    it('delete/archive retires an idle session even with no execution running', () => {
      const { close } = idleSession(payload.subChatId);

      abortActiveExecutionsForSubChats([payload.subChatId], 'chat deleted');

      expect(close).toHaveBeenCalledOnce();
      expect(getSession(payload.subChatId)).toBeUndefined();
    });

    it('a provider switch retires the idle Claude session', async () => {
      const { close } = idleSession(payload.subChatId);
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
        token: null,
        isApiKey: false,
        type: 'codex',
        label: 'codex-test',
        passthrough: true,
      });
      vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
        yield { type: 'finish', messageMetadata: { sessionId: 'codex' } } as UIMessageChunk;
      });

      await handleRemoteExecute({ ...payload, message: 'now in codex' });

      expect(close).toHaveBeenCalledOnce();
      expect(getSession(payload.subChatId)).toBeUndefined();
    });

    it('a sibling registering during spawn prep is waited out, never shared', async () => {
      vi.mocked(getMultiProjectContext).mockResolvedValue({
        promptPrefix: '',
        dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
      });
      let finishSibling = () => {};
      const siblingDone = new Promise<void>((resolve) => {
        finishSibling = resolve;
      });
      async function* siblingFrames(): AsyncGenerator<SDKMessage, void> {
        await siblingDone;
        yield { type: 'result', subtype: 'success' } as SDKMessage;
      }
      let sibling: ReturnType<typeof createSession> | undefined;
      // The staged MCP config is the await between the leftover check and the spawn.
      vi.mocked(fs.promises.writeFile).mockImplementation(async (file) => {
        if (sibling || !String(file).includes('mcp-config-')) return;
        sibling = createSession(payload.subChatId, () => siblingFrames() as unknown as Query);
        void runTurn(sibling, {} as SDKUserMessage, () => {});
        setTimeout(finishSibling, 20);
      });
      mockQuery(claudeQueryMock, oneTurn);

      await handleRemoteExecute({ ...payload, message: 'hello' });

      expect(claudeQueryMock).toHaveBeenCalledOnce();
      expect(sibling?.currentTurn).toBeNull();
      expect(getSession(payload.subChatId)).not.toBe(sibling);
      expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
      expect(socketClient.sendStreamChunkDirect).toHaveBeenCalledWith(
        expect.objectContaining({ chunk: expect.objectContaining({ delta: 'done' }) }),
      );
    });
  });
}
