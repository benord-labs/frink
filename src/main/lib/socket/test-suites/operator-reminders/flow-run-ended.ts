import { beforeEach, expect, it, vi } from 'vitest';
import { runCodexAgent } from '../../../agent-runner';
import type { UIMessageChunk } from '../../../claude/types';
import { getDefaultClaudeCodeToken } from '../../../credentials';
import { getNewestFlowRunForSubChat } from '../../../db/repos/flow-runs';
import { getLatestFlowTaskForSubChat } from '../../../db/repos/tasks';
import * as dynamicChatServer from '../../../mcp/dynamic-chat-server';
import {
  clearFlowRunEndedAnnouncementsForTests,
  FLOW_RUN_ENDED_NOTICE,
} from '../../flow-signal/flow-run-ended';
import { claudePromptText, userPromptSubmitReminder } from '../../test-utils';
import {
  type ClaudeQueryInput,
  deliveredRecord,
  firedReminders,
  mockClaudeFinishTurn,
  mockPinnedTaskChat,
  type OperatorReminderHarness,
} from './delivery';

/** The Flow-run-ended notice per runtime. Registered from executor.test.ts after the
 * operator-reminder suite, whose harness the shared turn mocks read. */
type WakeHookOptions = {
  hooks: {
    UserPromptSubmit: Array<{
      hooks: Array<
        (input: { hook_event_name: 'UserPromptSubmit'; source: string }) => Promise<{
          hookSpecificOutput?: { additionalContext?: string };
        }>
      >;
    }>;
  };
};

/** A follow-up into a chat whose last Flow step is done and whose newest run is `run`. */
function mockFollowUpAfterRun(run: { id: string; status: string }) {
  vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
  vi.mocked(getLatestFlowTaskForSubChat).mockResolvedValueOnce({
    id: `step-of-${run.id}`,
    status: 'done',
    flowRunId: run.id,
  });
  vi.mocked(getNewestFlowRunForSubChat).mockResolvedValueOnce(run);
  mockPinnedTaskChat(`step-of-${run.id}`, 'done');
}

export function registerFlowRunEndedTests({
  basePayload,
  claudeQueryMock,
  handleRemoteExecute,
}: OperatorReminderHarness): void {
  const followUp = {
    message: 'thanks',
    history: [
      { role: 'user' as const, content: 'do the task' },
      { role: 'assistant' as const, content: 'done' },
    ],
  };
  beforeEach(() => clearFlowRunEndedAnnouncementsForTests());
  const firedFor = (index: number) => firedReminders.get(claudeQueryMock.mock.calls[index][0]);
  const turnAfter = async (run: { id: string; status: string }, sessionId?: string) => {
    mockFollowUpAfterRun(run);
    mockClaudeFinishTurn('sess-run-ended');
    await handleRemoteExecute({ ...basePayload, ...followUp, ...(sessionId && { sessionId }) });
  };

  it('tells the agent once, on the first turn after the run ends, never while it runs', async () => {
    await turnAfter({ id: 'run-a', status: 'running' }, 'sess-run-ended');
    await turnAfter({ id: 'run-a', status: 'completed' }, 'sess-run-ended');
    await turnAfter({ id: 'run-a', status: 'completed' }, 'sess-run-ended');

    expect(firedFor(0)).not.toContain(FLOW_RUN_ENDED_NOTICE);
    expect(firedFor(1)).toContain(FLOW_RUN_ENDED_NOTICE);
    // The notice already says the signal tool is gone: the disarmed notice waits a turn.
    expect(firedFor(1)).not.toContain('intentionally not available');
    expect(await claudePromptText(claudeQueryMock.mock.calls[1][0].prompt)).not.toContain(
      FLOW_RUN_ENDED_NOTICE,
    );
    expect(firedFor(2)).not.toContain(FLOW_RUN_ENDED_NOTICE);
    expect(firedFor(2)).toContain('intentionally not available');
  });

  it('a later run resumes records, and its own end is announced again', async () => {
    await turnAfter({ id: 'run-a', status: 'cancelled' }, 'sess-run-ended');
    await turnAfter({ id: 'run-b', status: 'running' }, 'sess-run-ended');
    await turnAfter({ id: 'run-b', status: 'completed' }, 'sess-run-ended');

    expect(firedFor(0)).toContain(FLOW_RUN_ENDED_NOTICE);
    expect(deliveredRecord(claudeQueryMock.mock.calls[1][0])).toBeDefined();
    expect(firedFor(1)).not.toContain(FLOW_RUN_ENDED_NOTICE);
    expect(firedFor(2)).toContain(FLOW_RUN_ENDED_NOTICE);
  });

  it('gives no notice for a paused or failed run, which has not ended', async () => {
    await turnAfter({ id: 'run-a', status: 'paused' }, 'sess-run-ended');
    await turnAfter({ id: 'run-a', status: 'failed' }, 'sess-run-ended');
    expect(firedFor(0)).not.toContain(FLOW_RUN_ENDED_NOTICE);
    expect(firedFor(1)).not.toContain(FLOW_RUN_ENDED_NOTICE);
  });

  it('attaches the notice to the first prompt hook of the turn only', async () => {
    mockFollowUpAfterRun({ id: 'run-a', status: 'completed' });
    const fires: Array<string | undefined> = [];
    claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
      await input.prompt[Symbol.asyncIterator]().next();
      fires.push(await userPromptSubmitReminder(input, 'thanks'));
      fires.push(await userPromptSubmitReminder(input, 'a steer later in the turn'));
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-two-fires' } }] };
      yield { type: 'result' };
    });
    await handleRemoteExecute({ ...basePayload, ...followUp });
    expect(fires[0]).toContain(FLOW_RUN_ENDED_NOTICE);
    expect(fires[1] ?? '').not.toContain(FLOW_RUN_ENDED_NOTICE);
  });

  // Guards the source check: a wake that fires the hook first must not use up the turn's notice.
  it('keeps the notice for the turn prompt when a wake fires the hook first', async () => {
    mockFollowUpAfterRun({ id: 'run-a', status: 'completed' });
    const fires: Array<string | undefined> = [];
    claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
      await input.prompt[Symbol.asyncIterator]().next();
      // SAFETY: the executor always registers one UserPromptSubmit hook on a Claude turn.
      const hook = (input.options as WakeHookOptions).hooks.UserPromptSubmit[0].hooks[0];
      const wake = await hook({ hook_event_name: 'UserPromptSubmit', source: 'loop_wakeup' });
      fires.push(wake.hookSpecificOutput?.additionalContext);
      fires.push(await userPromptSubmitReminder(input, 'thanks'));
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-wake-first' } }] };
      yield { type: 'result' };
    });
    await handleRemoteExecute({ ...basePayload, ...followUp });
    expect(fires[0] ?? '').not.toContain(FLOW_RUN_ENDED_NOTICE);
    expect(fires[1]).toContain(FLOW_RUN_ENDED_NOTICE);
  });

  // The marker is written on delivery, not admission: a turn whose prompt never reached the CLI
  // must not use up the notice.
  it('re-sends the notice after a Claude turn that never delivered its prompt', async () => {
    mockFollowUpAfterRun({ id: 'run-a', status: 'completed' });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-run-ended' } }] };
      yield { type: 'result' };
    });
    await handleRemoteExecute({ ...basePayload, ...followUp, sessionId: 'sess-run-ended' });
    await turnAfter({ id: 'run-a', status: 'completed' }, 'sess-run-ended');
    expect(firedFor(1)).toContain(FLOW_RUN_ENDED_NOTICE);
  });

  // Wiring: the executor's onAccepted callback is what marks a Codex turn as told.
  it('marks a Codex turn as told only once turn/start accepts it', async () => {
    const codexTurn = (accept: boolean) => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
        token: null,
        isApiKey: false,
        type: 'codex',
        label: 'codex-test',
        passthrough: true,
      });
      mockFollowUpAfterRun({ id: 'run-a', status: 'completed' });
      vi.mocked(runCodexAgent).mockImplementationOnce(async function* (params) {
        if (accept) params.flowRunEnded?.onAccepted();
        yield {
          type: 'finish',
          messageMetadata: { sessionId: 'codex-thread' },
        } satisfies UIMessageChunk;
      });
      return handleRemoteExecute({ ...basePayload, ...followUp, sessionId: 'codex-thread' });
    };
    await codexTurn(false);
    await codexTurn(true);
    await codexTurn(true);
    const sent = vi.mocked(runCodexAgent).mock.calls.map(([params]) => params.flowRunEnded?.text);
    expect(sent).toEqual([FLOW_RUN_ENDED_NOTICE, FLOW_RUN_ENDED_NOTICE, undefined]);
  });

  it('Codex gets the notice as native context, not in the message body', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    mockFollowUpAfterRun({ id: 'run-a', status: 'completed' });
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-ended' },
      } satisfies UIMessageChunk;
    });
    await handleRemoteExecute({ ...basePayload, ...followUp });
    const params = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    expect(params?.flowRunEnded?.text).toBe(FLOW_RUN_ENDED_NOTICE);
    expect(params?.prompt).not.toContain(FLOW_RUN_ENDED_NOTICE);
    // The run-ended notice already says the signal tool is gone, so no disarmed entry joins it.
    expect(params?.operatorReminders).toEqual({});
  });
}
