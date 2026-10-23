import { describe, expect, it, vi } from 'vitest';
import { nodeTurnUsage, type TurnUsage } from '../../../../../shared/types/turn-usage';
import { runCodexAgent } from '../../../agent-runner';
import type { UIMessageChunk } from '../../../claude/types';
import { getDefaultClaudeCodeToken } from '../../../credentials';
import { getChatWithProjectAccount } from '../../../db/repos/chats';
import * as taskTurnUsage from '../../../db/repos/task-turn-usage';
import { getTaskById, updateTaskStatus } from '../../../db/repos/tasks';
import { getLatestTaskSignal } from '../../../mcp/dynamic-chat-server';
import { getMultiProjectContext } from '../../../multi-project-prompt';
import type { OperatorReminderHarness } from '../operator-reminders/delivery';

// SAFETY: the stamp and the signal flip read only id, status and result off the row.
const runningTask = {
  id: 'task-usage',
  status: 'running',
  result: { executionLeaseId: 'lease-u' },
} as Awaited<ReturnType<typeof getTaskById>>;

// SAFETY: the executor reads only chat.taskId off this lookup.
const linkedChat = { chat: { taskId: 'task-usage' }, account: null } as Awaited<
  ReturnType<typeof getChatWithProjectAccount>
>;

function linkedDoneTurn(): void {
  vi.mocked(getMultiProjectContext).mockResolvedValue({
    promptPrefix: '',
    dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
  });
  vi.mocked(getLatestTaskSignal).mockReset();
  vi.mocked(getLatestTaskSignal).mockReturnValue({
    state: 'done',
    summary: 'done',
    at: new Date().toISOString(),
  });
  vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce(linkedChat);
  vi.mocked(getTaskById).mockReset();
  vi.mocked(getTaskById).mockResolvedValue(runningTask);
}

/** The node's usage must be on the row before updateTaskStatus advances the flow. */
async function runAndExpectStampBeforeFlip(
  h: OperatorReminderHarness,
  message: string,
  turnUsage: TurnUsage,
): Promise<void> {
  const stamp = vi.spyOn(taskTurnUsage, 'patchTaskTurnUsage').mockResolvedValue(true);
  await h.handleRemoteExecute({ ...h.basePayload, message });
  expect(stamp).toHaveBeenCalledTimes(1);
  const [, taskId, patch] = stamp.mock.calls[0];
  expect(taskId).toBe('task-usage');
  expect(nodeTurnUsage(patch)).toEqual(turnUsage);
  const flip = vi.mocked(updateTaskStatus).mock.invocationCallOrder[0];
  expect(flip).toBeDefined();
  expect(stamp.mock.invocationCallOrder[0]).toBeLessThan(flip);
  stamp.mockRestore();
}

/** The transcript finalize lands after the terminal flip, so the executor stamps usage first. */
export function registerTurnUsageStampTests(h: OperatorReminderHarness): void {
  describe('turn usage stamped before the terminal flip', () => {
    it('records a Claude turn with its compaction count', async () => {
      linkedDoneTurn();
      h.claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          chunks: [
            { type: 'data-compact', id: 'c1', data: { state: 'output-available' } },
            { type: 'finish', messageMetadata: { sessionId: 's-u', contextTokens: 42_000 } },
          ],
        };
        yield { type: 'result' };
      });

      await runAndExpectStampBeforeFlip(h, 'claude usage', {
        contextTokens: 42_000,
        compactions: 1,
      });
    });

    it('records a Codex turn with a null compaction count', async () => {
      linkedDoneTurn();
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
        token: null,
        isApiKey: false,
        type: 'codex',
        label: 'codex-test',
        passthrough: true,
      });
      const chunks: UIMessageChunk[] = [
        {
          type: 'message-metadata',
          messageMetadata: { sessionId: 'sess-u', contextTokens: 31_000 },
        },
        { type: 'finish' },
      ];
      vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
        yield* chunks;
      });

      await runAndExpectStampBeforeFlip(h, 'codex usage', {
        contextTokens: 31_000,
        compactions: null,
      });
    });
  });
}
