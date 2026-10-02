import { describe, expect, it, vi } from 'vitest';
import { runCodexAgent } from '../../agent-runner';
import type { UIMessageChunk } from '../../claude/types';
import { getDefaultClaudeCodeToken } from '../../credentials';
import { getChatWithProjectAccount } from '../../db/repos/chats';
import { getFlowDriveInfoForSubChat, getTaskById } from '../../db/repos/tasks';
import * as dynamicChatServer from '../../mcp/dynamic-chat-server';
import { getMultiProjectContext } from '../../multi-project-prompt';
import { HUMAN_INTERJECTION_STOP_REASON } from '../../task-stop-hook';
import { resumeParkedTaskInPlace } from '../../tasks';
import { claudePromptText, userPromptSubmitReminder } from '../test-utils';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

/** Operator-reminder delivery (disarmed notice, sc-3214 human mark, its Stop wording) per runtime.
 * Registered from executor.test.ts, whose module mocks it relies on. */
type OperatorReminderHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};

let harness: OperatorReminderHarness;

/** What each spawned CLI's UserPromptSubmit hook injected, captured as the CLI reads its prompt. */
const firedReminders = new WeakMap<object, string | undefined>();

function mockPinnedTaskChat(taskId: string, row: { status: string; result?: unknown } | null) {
  vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
    chat: { taskId },
    account: null,
  } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
  vi.mocked(getTaskById).mockResolvedValueOnce(
    (row ? { id: taskId, result: {}, ...row } : null) as Awaited<ReturnType<typeof getTaskById>>,
  );
}

/** Mock one Claude turn whose stream finishes immediately. */
function mockClaudeFinishTurn(sessionId: string) {
  harness.claudeQueryMock.mockImplementationOnce(async function* (input: object) {
    firedReminders.set(input, await userPromptSubmitReminder(input));
    yield { chunks: [{ type: 'finish', messageMetadata: { sessionId } }] };
    yield { type: 'result' };
  });
}

/** A person's reply into a chat whose flow step parked after signalling `partial` (sc-3214). */
function mockParkedPartialFlowStep(sessionId: string | null) {
  vi.mocked(getMultiProjectContext).mockResolvedValue({
    promptPrefix: '',
    dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
  });
  vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
    chat: { taskId: 'pinned-upstream-task' },
    account: null,
  } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
  vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
    active: true,
    autoApprovePlan: false,
    taskId: 'flow-step-task',
  });
  vi.mocked(getTaskById).mockResolvedValueOnce({
    id: 'flow-step-task',
    title: 'Triage sc-2717',
    status: 'needs_attention',
    flowRunId: 'fr-3214',
    nodeRunId: 'nr-3214',
    result: {
      agentSignal: { state: 'partial', summary: 'description edit denied' },
    },
  } as Awaited<ReturnType<typeof getTaskById>>);
  if (sessionId) mockClaudeFinishTurn(sessionId);
}

/** Runs one Claude turn that stops WITHOUT a signal and returns the Stop hook's verdict. */
async function stopVerdictFor(payloadOver: Record<string, unknown>): Promise<unknown> {
  vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
  let verdict: unknown;
  harness.claudeQueryMock.mockImplementationOnce(async function* (queryInput: object) {
    const input = queryInput as {
      prompt: AsyncIterable<unknown>;
      options?: {
        hooks?: { Stop?: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> };
      };
    };
    await input.prompt[Symbol.asyncIterator]().next();
    verdict = await input.options?.hooks?.Stop?.[0]?.hooks?.[0]?.({
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    yield {
      type: 'result',
      chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-stop-reason' } }],
    };
  });
  await harness.handleRemoteExecute({
    ...harness.basePayload,
    message: 'hello',
    ...payloadOver,
  });
  return verdict;
}

export function registerOperatorReminderDeliveryTests(h: OperatorReminderHarness): void {
  harness = h;
  describe('operator reminder delivery: disarmed task-signal notice', () =>
    registerDisarmedTests(h));
  describe('operator reminder delivery: a person typing into a flow step (sc-3214)', () => {
    registerHumanMarkTests(h);
    registerHumanStopAndCodexTests(h);
  });
}

function registerDisarmedTests({
  basePayload,
  claudeQueryMock,
  handleRemoteExecute,
}: OperatorReminderHarness): void {
  it('delivers the disarmed reminder via the UserPromptSubmit hook on a dead-chat follow-up with prior turns, but not on an armed turn', async () => {
    // Claude: via the UserPromptSubmit hook, never the user prompt; only once prior turns exist
    // (here: inlined history) for the agent to have seen the now-stripped tool.
    const callOf = (callIndex: number) => claudeQueryMock.mock.calls[callIndex][0];
    const priorTurns = [
      { role: 'user' as const, content: 'do the task' },
      { role: 'assistant' as const, content: 'done, signalling now' },
    ];

    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    mockPinnedTaskChat('task-armed-reminder', { status: 'running' });
    mockClaudeFinishTurn('sess-reminder-armed');

    await handleRemoteExecute({ ...basePayload, message: 'armed turn', history: priorTurns });

    expect(firedReminders.get(callOf(0))).toBeUndefined();

    mockPinnedTaskChat('task-dead-reminder', { status: 'done' });
    mockClaudeFinishTurn('sess-reminder-dead');

    await handleRemoteExecute({
      ...basePayload,
      message: 'follow-up on dead chat',
      history: priorTurns,
    });

    const reminder = firedReminders.get(callOf(1));
    expect(reminder).toContain('intentionally not available');
    expect(reminder).toContain('frink_task_signal');
    // Delivered via the hook, not the user prompt.
    expect(await claudePromptText(callOf(1).prompt)).not.toContain('intentionally not available');
  });

  it('omits the disarmed reminder on a fresh first turn with no prior context', async () => {
    // No prior context → the notice would be vacuous. `history: undefined` is what the renderer
    // really sends on a first turn (not []), guarding the optional-history crash.
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('task-dead-fresh', { status: 'done' });
    mockClaudeFinishTurn('sess-reminder-fresh');

    await handleRemoteExecute({ ...basePayload, message: 'first turn', history: undefined });

    expect(firedReminders.get(claudeQueryMock.mock.calls[0][0])).toBeUndefined();
  });

  it('delivers the disarmed reminder via the hook regardless of an image attachment', async () => {
    // The hook channel is independent of prompt shape, so an image attachment (which switches
    // buildPromptForClaude to its async-iterable form) does not affect reminder delivery.
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('task-dead-image', { status: 'done' });
    mockClaudeFinishTurn('sess-reminder-dead-image');

    await handleRemoteExecute({
      ...basePayload,
      message: 'what does this screenshot show?',
      history: [
        { role: 'user', content: 'do the task' },
        { role: 'assistant', content: 'done' },
      ],
      userMessageParts: [{ type: 'file', mimeType: 'image/png', data: 'AAAA' }],
    });

    expect(firedReminders.get(claudeQueryMock.mock.calls[0][0])).toContain(
      'intentionally not available',
    );
  });
}

function registerHumanMarkTests({
  basePayload,
  claudeQueryMock,
  handleRemoteExecute,
}: OperatorReminderHarness): void {
  it('marks a turn a person typed into a parked flow step, naming the step and its prior signal', async () => {
    mockParkedPartialFlowStep('sess-human-interjection');

    await handleRemoteExecute({
      ...basePayload,
      message: 'I have modified the ticket to say devkit for you',
      typedByPerson: true,
    });

    const reminder = firedReminders.get(claudeQueryMock.mock.calls[0][0]);
    expect(reminder).toContain('typed by a person');
    expect(reminder).toContain('"Triage sc-2717"');
    // Read from the turn-start row, before the follow-up resume scrubs agentSignal.
    expect(reminder).toContain('parked after signalling `partial`');
    expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'flow-step-task' }),
      'follow_up_message',
      basePayload.subChatId,
    );
  });

  it('never marks a machine-dispatched turn on the same flow step', async () => {
    mockParkedPartialFlowStep('sess-flow-dispatch');

    await handleRemoteExecute({
      ...basePayload,
      message: 'next flow step',
      typedByPerson: false,
    });

    expect(firedReminders.get(claudeQueryMock.mock.calls[0][0])).toBeUndefined();
  });

  it('points a person answering a parked flow PLAN step at ExitPlanMode, not a terminal signal', async () => {
    mockParkedPartialFlowStep('sess-human-plan');

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      message: 'use bun',
      typedByPerson: true,
    });

    const reminder = firedReminders.get(claudeQueryMock.mock.calls[0][0]);
    expect(reminder).toContain('typed by a person');
    expect(reminder).toContain('ExitPlanMode');
    expect(reminder).not.toContain('call frink_task_signal for this step');
  });

  it('does not mark a person typing into an interactive (non-flow) task chat', async () => {
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    mockPinnedTaskChat('task-work-queue', { status: 'running' });
    mockClaudeFinishTurn('sess-non-flow-human');

    await handleRemoteExecute({
      ...basePayload,
      message: 'tweak it',
      typedByPerson: true,
    });

    expect(firedReminders.get(claudeQueryMock.mock.calls[0][0]) ?? '').not.toContain(
      'typed by a person',
    );
  });

  it('does not mark a person typing into a flow chat whose step already finished (disarmed)', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('task-flow-finished', { status: 'done' });
    mockClaudeFinishTurn('sess-finished-human');

    await handleRemoteExecute({
      ...basePayload,
      message: 'thanks',
      typedByPerson: true,
      history: [
        { role: 'user', content: 'do the task' },
        { role: 'assistant', content: 'done' },
      ],
    });

    const reminder = firedReminders.get(claudeQueryMock.mock.calls[0][0]);
    expect(reminder).toContain('intentionally not available');
    expect(reminder).not.toContain('typed by a person');
  });
}

function registerHumanStopAndCodexTests({
  basePayload,
  handleRemoteExecute,
}: OperatorReminderHarness): void {
  it('asks a human-interjection turn that stops unsignalled to re-signal, in the human wording', async () => {
    mockParkedPartialFlowStep(null);
    expect(await stopVerdictFor({ typedByPerson: true })).toEqual({
      decision: 'block',
      reason: HUMAN_INTERJECTION_STOP_REASON,
    });
  });

  it('keeps the standard Stop wording for a machine-dispatched turn on the same flow step', async () => {
    mockParkedPartialFlowStep(null);
    const verdict = (await stopVerdictFor({ typedByPerson: false })) as { reason?: string };
    expect(verdict).toEqual({
      decision: 'block',
      reason: expect.stringContaining('frink_task_signal'),
    });
    expect(verdict.reason).not.toBe(HUMAN_INTERJECTION_STOP_REASON);
  });

  it('Codex: prepends the human-interjection reminder to the prompt (no system-prompt channel)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    mockParkedPartialFlowStep(null);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-human' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'I edited it',
      typedByPerson: true,
    });

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[0]?.prompt ?? '';
    expect(prompt).toContain('<system-reminder>');
    expect(prompt).toContain('typed by a person');
    expect(prompt).toContain('parked after signalling `partial`');
    expect(prompt.indexOf('typed by a person')).toBeLessThan(prompt.indexOf('I edited it'));
  });
}
