import { buildFrinkSystemPromptAppend } from '../../frink-system-prompt';
import {
  MESSAGE_PROVENANCE_RULE,
  type MessageProvenance,
} from '../../../../shared/lib/message-markers/message-provenance';
import { describe, expect, it, vi } from 'vitest';
import { runCodexAgent } from '../../agent-runner';
import type { UIMessageChunk } from '../../claude/types';
import { getDefaultClaudeCodeToken } from '../../credentials';
import { getChatWithProjectAccount } from '../../db/repos/chats';
import { getNewestFlowRunForSubChat } from '../../db/repos/flow-runs';
import {
  getFlowDriveInfoForSubChat,
  getLatestFlowTaskForSubChat,
  getTaskById,
} from '../../db/repos/tasks';
import * as dynamicChatServer from '../../mcp/dynamic-chat-server';
import { getMultiProjectContext } from '../../multi-project-prompt';
import { resumeParkedTaskInPlace } from '../../tasks';
import type { MessageDelivery } from '../execution/message-provenance/origin';
import { claudePromptText, userPromptSubmitReminder, type ClaudeQueryCall } from '../test-utils';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

/** Operator-reminder and message-provenance delivery (disarmed notice, source record) per runtime.
 * Registered from executor.test.ts, whose module mocks it relies on. */
type OperatorReminderHarness = Pick<
  ExecutorPermissionHarness,
  'basePayload' | 'handleRemoteExecute'
> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};

let harness: OperatorReminderHarness;

type StopVerdict = { decision?: string; reason?: string };
type StopHook = (input: {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
}) => Promise<StopVerdict>;
type QueuedPrompt = { message: { content: string | Array<{ type: string; text?: string }> } };
/** One claudeQuery call as these tests read it: the queued prompt plus the registered hooks. */
type ClaudeQueryInput = ClaudeQueryCall & {
  prompt: AsyncIterable<QueuedPrompt>;
  options?: { hooks?: { Stop?: Array<{ hooks: StopHook[] }> } };
};

/** What each spawned CLI's UserPromptSubmit hook injected, captured as the CLI reads its prompt. */
const firedReminders = new WeakMap<ClaudeQueryInput, string | undefined>();

function mockPinnedTaskChat(taskId: string, status: string) {
  // SAFETY: arming reads only `chat.taskId` and `account` from this row.
  vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
    chat: { taskId },
    account: null,
  } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
  // SAFETY: arming reads only the id, status and result of the pinned task.
  const row = { id: taskId, result: {}, status } as Awaited<ReturnType<typeof getTaskById>>;
  vi.mocked(getTaskById).mockResolvedValueOnce(row);
}

/** The prompt text as the CLI hands it to the hook: text blocks joined by newlines, then trimmed. */
function hookPromptText(content: QueuedPrompt['message']['content']): string {
  if (!Array.isArray(content)) return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** Mock one Claude turn whose stream finishes immediately. */
function mockClaudeFinishTurn(sessionId: string) {
  harness.claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
    const queued = await input.prompt[Symbol.asyncIterator]().next();
    const text = hookPromptText(queued.value?.message.content ?? '');
    firedReminders.set(input, await userPromptSubmitReminder(input, text));
    yield { chunks: [{ type: 'finish', messageMetadata: { sessionId } }] };
    yield { type: 'result' };
  });
}

/** A person's reply into a chat whose flow step parked after signalling `partial`. */
function mockParkedPartialFlowStep(sessionId: string | null) {
  vi.mocked(getNewestFlowRunForSubChat).mockResolvedValueOnce({ id: 'fr-3214', status: 'running' });
  vi.mocked(getMultiProjectContext).mockResolvedValue({
    promptPrefix: '',
    dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
  });
  // SAFETY: arming reads only `chat.taskId` and `account` from this row.
  vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
    chat: { taskId: 'pinned-upstream-task' },
    account: null,
  } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
  vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
    active: true,
    autoApprovePlan: false,
    taskId: 'flow-step-task',
  });
  // SAFETY: the record is built from these six columns alone; the rest of the row is never read.
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
async function stopVerdictFor(delivery: MessageDelivery): Promise<StopVerdict | undefined> {
  vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
  let verdict: StopVerdict | undefined;
  harness.claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
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
    delivery,
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
    mockPinnedTaskChat('task-armed-reminder', 'running');
    mockClaudeFinishTurn('sess-reminder-armed');

    await handleRemoteExecute({ ...basePayload, message: 'armed turn', history: priorTurns });

    expect(firedReminders.get(callOf(0))).toBeUndefined();

    mockPinnedTaskChat('task-dead-reminder', 'done');
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
    mockPinnedTaskChat('task-dead-fresh', 'done');
    mockClaudeFinishTurn('sess-reminder-fresh');

    await handleRemoteExecute({ ...basePayload, message: 'first turn', history: undefined });

    expect(firedReminders.get(claudeQueryMock.mock.calls[0][0])).toBeUndefined();
  });

  it('delivers the disarmed reminder via the hook regardless of an image attachment', async () => {
    // The hook channel is independent of prompt shape, so an image attachment (which switches
    // buildPromptForClaude to its async-iterable form) does not affect reminder delivery.
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('task-dead-image', 'done');
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

function deliveredRecord(call: ClaudeQueryInput): MessageProvenance | undefined {
  const match = firedReminders.get(call)?.match(/<frink_message>(.*?)<\/frink_message>/s);
  return match ? JSON.parse(match[1]!) : undefined;
}

function registerHumanMarkTests({
  basePayload,
  claudeQueryMock,
  handleRemoteExecute,
}: OperatorReminderHarness): void {
  it('marks a person reply with pre-resume step facts and the actual successful resume', async () => {
    mockParkedPartialFlowStep('sess-human-interjection');
    await handleRemoteExecute({
      ...basePayload,
      message: 'I edited the ticket',
      delivery: { messageOrigin: { source: 'person', kind: 'message' } },
    });
    const call = claudeQueryMock.mock.calls[0][0];
    expect(deliveredRecord(call)).toMatchObject({
      source: 'person',
      kind: 'message',
      step: {
        name: 'Triage sc-2717',
        was_paused: true,
        previous_signal: 'partial',
        signal_cleared: true,
      },
    });
    expect(call.options.systemPrompt.append).toContain(MESSAGE_PROVENANCE_RULE);
    expect(resumeParkedTaskInPlace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'flow-step-task' }),
      'follow_up_message',
      basePayload.subChatId,
    );
  });

  it('does not claim signal clearing when resume did not apply', async () => {
    mockParkedPartialFlowStep('sess-resume-noop');
    vi.mocked(resumeParkedTaskInPlace).mockResolvedValueOnce(false);
    await handleRemoteExecute({
      ...basePayload,
      message: 'hello',
      delivery: { messageOrigin: { source: 'person', kind: 'message' } },
    });
    expect(deliveredRecord(claudeQueryMock.mock.calls[0][0])?.step?.signal_cleared).toBeUndefined();
  });

  it('marks known Flow task dispatches as flow even without the renderer marker', async () => {
    mockParkedPartialFlowStep('sess-flow-dispatch');
    await handleRemoteExecute({
      ...basePayload,
      message: 'next step',
      delivery: {
        messageOrigin: { source: 'internal', kind: 'message' },
        dispatchTaskId: 'flow-step-task',
      },
    });
    expect(deliveredRecord(claudeQueryMock.mock.calls[0][0])?.source).toBe('flow');
  });

  it('keeps plan lifecycle guidance while emitting factual metadata', async () => {
    mockParkedPartialFlowStep('sess-human-plan');
    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      message: 'use bun',
      delivery: { messageOrigin: { source: 'person', kind: 'message' } },
    });
    const call = claudeQueryMock.mock.calls[0][0];
    expect(deliveredRecord(call)?.source).toBe('person');
    expect(buildFrinkSystemPromptAppend).toHaveBeenCalledWith(
      expect.objectContaining({ isPlanMode: true, isFlowDriven: true }),
    );
    expect(call.options.systemPrompt.append).toContain('existing mode-specific lifecycle rules');
  });

  it('leaves ordinary task chats without a record or definition', async () => {
    mockPinnedTaskChat('task-work-queue', 'running');
    mockClaudeFinishTurn('sess-non-flow-human');
    await handleRemoteExecute({
      ...basePayload,
      message: 'tweak it',
      delivery: { messageOrigin: { source: 'person', kind: 'message' } },
    });
    const call = claudeQueryMock.mock.calls[0][0];
    expect(deliveredRecord(call)).toBeUndefined();
    expect(call.options.systemPrompt.append).not.toContain(MESSAGE_PROVENANCE_RULE);
  });

  /** A chat whose last Flow step is done; `runLive` says whether its run is still going. */
  function mockChatAfterLastStep(runLive: boolean) {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    vi.mocked(getLatestFlowTaskForSubChat).mockResolvedValueOnce({
      id: 'task-flow-finished',
      status: 'done',
      flowRunId: 'run-after-last-step',
    });
    vi.mocked(getNewestFlowRunForSubChat).mockResolvedValueOnce({
      id: 'run-after-last-step',
      status: runLive ? 'running' : 'completed',
    });
    mockPinnedTaskChat('task-flow-finished', 'done');
    mockClaudeFinishTurn('sess-finished-human');
  }
  const followUp = {
    message: 'thanks',
    delivery: { messageOrigin: { source: 'person', kind: 'message' } as const },
    history: [
      { role: 'user' as const, content: 'do the task' },
      { role: 'assistant' as const, content: 'done' },
    ],
  };

  it('sends no record and no rule once the Flow run has ended', async () => {
    mockChatAfterLastStep(false);
    await handleRemoteExecute({ ...basePayload, ...followUp });
    const call = claudeQueryMock.mock.calls[0][0];
    expect(deliveredRecord(call)).toBeUndefined();
    expect(firedReminders.get(call)).toContain('intentionally not available');
    expect(call.options.systemPrompt.append).not.toContain(MESSAGE_PROVENANCE_RULE);
  });

  it('still marks a person typing between two steps of a run that is going', async () => {
    mockChatAfterLastStep(true);
    await handleRemoteExecute({ ...basePayload, ...followUp });
    const call = claudeQueryMock.mock.calls[0][0];
    expect(deliveredRecord(call)).toMatchObject({ source: 'person' });
    expect(deliveredRecord(call)?.step).toBeUndefined();
    expect(call.options.systemPrompt.append).toContain(MESSAGE_PROVENANCE_RULE);
  });
}

function registerHumanStopAndCodexTests({
  basePayload,
  handleRemoteExecute,
}: OperatorReminderHarness): void {
  it('retains the ordinary Stop contract after a person replies', async () => {
    mockParkedPartialFlowStep(null);
    expect(await stopVerdictFor({ messageOrigin: { source: 'person', kind: 'message' } })).toEqual({
      decision: 'block',
      reason: expect.stringContaining('You stopped without calling frink_task_signal'),
    });
  });

  it('Codex carries the record separately from the unchanged message body', async () => {
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
      } satisfies UIMessageChunk;
    });
    await handleRemoteExecute({
      ...basePayload,
      message: 'I edited it',
      delivery: { messageOrigin: { source: 'person', kind: 'message' } },
    });
    const params = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    expect(params?.messageProvenance).toMatchObject({
      source: 'person',
      step: { previous_signal: 'partial', signal_cleared: true },
    });
    expect(params?.prompt).toContain('I edited it');
    expect(params?.prompt).not.toContain('<frink_message>');
    expect(params?.prompt).not.toContain('typed by a person');
  });
}
