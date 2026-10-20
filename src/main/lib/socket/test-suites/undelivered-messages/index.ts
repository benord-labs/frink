import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { runCodexAgent } from '../../../agent-runner';
import type { UIMessageChunk } from '../../../claude/types';
import { getDefaultClaudeCodeToken } from '../../../credentials';
import { getMultiProjectContext } from '../../../multi-project-prompt';
import { clearUndeliveredMessagesForTests } from '../../execution/prompt-prefix/undelivered-messages';
import { handleRemoteStop } from '../../executor';
import { userPromptSubmitReminder } from '../../test-utils';
import type { ClaudeQueryInput, OperatorReminderHarness } from '../operator-reminders/delivery';

const STOPPED = 'restart the hub';
const CARRIED = `<conversation_history>\nHuman: ${STOPPED}\n</conversation_history>`;
const turnEnd = (sessionId: string) => [
  { chunks: [{ type: 'finish', messageMetadata: { sessionId } }] },
  { type: 'result' },
];
const TURN_END = turnEnd('sess-resumed');
/** The chat transcript a turn that starts fresh is seeded from: it already holds the stopped bubble. */
const HISTORY = [
  { role: 'assistant' as const, content: 'earlier answer' },
  { role: 'user' as const, content: STOPPED },
];
const PROVIDER_TYPE = { codex: 'codex', acp: 'opencode', copilot: 'copilot' } as const;
const AGENT_RUNTIMES = ['codex', 'acp', 'copilot'] as const;
const REPLY: UIMessageChunk = { type: 'text-delta', id: 't1', delta: 'on it' };
const timesIn = (text: string | undefined, part: string) => (text ?? '').split(part).length - 1;

type AgentTurn = { prompt: string; freshSessionFallbackPrompt?: string };
type AgentRuntime = (typeof AGENT_RUNTIMES)[number];
type Script = (turn: AgentTurn) => AsyncGenerator<UIMessageChunk, void, undefined>;

/** An agent turn that answers and finishes on `sessionId`. */
const answersOn = (sessionId: string) =>
  async function* (): AsyncGenerator<UIMessageChunk, void, undefined> {
    yield REPLY;
    yield { type: 'finish', messageMetadata: { sessionId } };
  };
const answers = answersOn('agent-session');
/** The transcript of a chat a slash command is typed into, on a session that starts fresh. */
const CHAT = [
  { role: 'user' as const, content: 'first question', personAuthored: true as const },
  { role: 'assistant' as const, content: 'first answer' },
  { role: 'user' as const, content: 'second question', personAuthored: true as const },
];
const AFTER_REVIEW = [
  ...CHAT,
  { role: 'user' as const, content: '/review', personAuthored: true as const },
  { role: 'assistant' as const, content: 'review notes' },
];
type Overrides = Parameters<OperatorReminderHarness['handleRemoteExecute']>[1];

/** A message whose turn ends before the provider takes its prompt reaches the next turn that
 * resumes the provider's own transcript. Registered from executor.test.ts, whose mocks it uses. */
export function registerUndeliveredMessageTests({
  basePayload,
  claudeQueryMock,
  handleRemoteExecute,
}: OperatorReminderHarness): void {
  let payload: typeof basePayload;
  let prompts: string[];
  beforeEach(() => {
    clearUndeliveredMessagesForTests();
    prompts = [];
    payload = {
      ...basePayload,
      subChatId: randomUUID(),
      sessionId: 'sess-resumed',
      delivery: { messageOrigin: { source: 'person', kind: 'message' } },
    };
  });

  /** One CLI that reads its prompt, takes it through the prompt hook and ends the turn. */
  const mockClaudeTurn = (sessionId = 'sess-resumed') =>
    claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
      const queued = await input.prompt[Symbol.asyncIterator]().next();
      const text = String(queued.value?.message.content);
      prompts.push(text);
      await userPromptSubmitReminder(input, text);
      yield* turnEnd(sessionId);
    });

  /** A turn the user stops while Frink is still preparing it, before any agent sees the prompt. */
  const stoppedWhilePreparing = async (turn: typeof payload, overrides?: Overrides) => {
    vi.mocked(getMultiProjectContext).mockImplementationOnce(async () => {
      handleRemoteStop(turn);
      return { promptPrefix: '', dynamicChatMcpUrl: null };
    });
    await handleRemoteExecute({ ...turn, message: STOPPED }, overrides);
    expect(claudeQueryMock).not.toHaveBeenCalled();
    expect(runCodexAgent).not.toHaveBeenCalled();
  };

  it('Claude: a message stopped before the CLI saw it reaches the next turn, once', async () => {
    await stoppedWhilePreparing(payload);
    mockClaudeTurn();
    mockClaudeTurn();
    await handleRemoteExecute({ ...payload, message: 'with latest code' });
    await handleRemoteExecute({ ...payload, message: 'thanks' });

    expect(prompts[0]).toContain(CARRIED);
    expect(prompts[0].endsWith('with latest code')).toBe(true);
    expect(prompts[1]).toBe('thanks');
  });

  it('Claude: a wake firing the prompt hook is not the CLI taking the message', async () => {
    claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
      await userPromptSubmitReminder(input, '', 'loop_wakeup');
      yield* TURN_END;
    });
    await handleRemoteExecute({ ...payload, message: STOPPED }).catch(() => {});
    mockClaudeTurn();
    await handleRemoteExecute({ ...payload, message: 'with latest code' });

    expect(prompts[0]).toContain(CARRIED);
  });

  it('a session that starts fresh reads the stopped message from the transcript only', async () => {
    const fresh = { ...payload, sessionId: undefined };
    await stoppedWhilePreparing(fresh);
    mockClaudeTurn();
    await handleRemoteExecute({ ...fresh, message: 'with latest code', history: HISTORY });

    expect(prompts[0]).toContain('Assistant: earlier answer');
    expect(timesIn(prompts[0], STOPPED)).toBe(1);
  });

  it('a reply declined before its turn was registered is never carried', async () => {
    await handleRemoteExecute({ ...payload, message: STOPPED, expectedFlowTaskId: 'moved-on' });
    mockClaudeTurn();
    await handleRemoteExecute({ ...payload, message: 'with latest code' });

    expect(prompts).toEqual(['with latest code']);
  });

  /** Runs each agent turn through the next script, keeping what the agent was sent. */
  const agentScripts = (runtime: AgentRuntime, scripts: Script[]) => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue({
      token: null,
      isApiKey: false,
      type: PROVIDER_TYPE[runtime],
      label: runtime,
      passthrough: true,
    });
    const sent: AgentTurn[] = [];
    const next = (turn: AgentTurn) => {
      sent.push(turn);
      return scripts[sent.length - 1](turn);
    };
    // Only Codex reads these; one left queued would answer a later test's Codex turn.
    if (runtime === 'codex') {
      for (const _script of scripts) {
        vi.mocked(runCodexAgent).mockImplementationOnce((params) =>
          next({
            prompt: params.prompt,
            freshSessionFallbackPrompt: params.freshThreadFallbackPrompt,
          }),
        );
      }
    }
    const overrides = { runtimeFor: () => runtime, startAcpTurn: next, startCopilotTurn: next };
    const send = (message: string, turn: Partial<typeof payload> = {}) =>
      handleRemoteExecute(
        { ...payload, message, history: HISTORY, sessionId: 'agent-session', ...turn },
        overrides,
      );
    return { sent, send, overrides };
  };

  it.each(AGENT_RUNTIMES)(
    '%s: a message stopped before the agent saw it reaches the next turn once',
    async (runtime) => {
      const { sent, send, overrides } = agentScripts(runtime, [answers, answers]);

      await stoppedWhilePreparing({ ...payload, sessionId: 'agent-session' }, overrides);
      expect(sent).toEqual([]);
      await send('with latest code');
      await send('thanks');

      expect(sent[0].prompt).toContain(CARRIED);
      expect(sent[0].prompt.endsWith('with latest code')).toBe(true);
      expect(sent[1].prompt).not.toContain(STOPPED);
      // A session the agent cannot resume is seeded from the transcript, which already has it.
      expect(sent[0].freshSessionFallbackPrompt).toContain('Assistant: earlier answer');
      expect(timesIn(sent[0].freshSessionFallbackPrompt, STOPPED)).toBe(1);
    },
  );

  it.each(AGENT_RUNTIMES)(
    '%s: a Stop before the agent answers keeps the message owed, a Stop mid-answer does not',
    async (runtime) => {
      async function* stoppedBeforeAnswer(): AsyncGenerator<UIMessageChunk, void, undefined> {
        yield { type: 'message-metadata', messageMetadata: { sessionId: 'agent-session' } };
        handleRemoteStop(payload);
        yield REPLY;
      }
      async function* stoppedMidAnswer(): AsyncGenerator<UIMessageChunk, void, undefined> {
        yield REPLY;
        handleRemoteStop(payload);
        yield REPLY;
      }
      const scripts = [stoppedBeforeAnswer, stoppedMidAnswer, answers];
      const { sent, send } = agentScripts(runtime, scripts);

      await send(STOPPED);
      await send('with latest code');
      await send('thanks');

      expect(sent[1].prompt).toContain(CARRIED);
      expect(sent[2].prompt).not.toContain(STOPPED);
      expect(sent[2].prompt).not.toContain('with latest code');
    },
  );

  registerFreshCommandTests({
    claudeQueryMock,
    handleRemoteExecute,
    current: () => ({ payload, prompts }),
    mockClaudeTurn,
    agentScripts,
  });
}

type Payload = OperatorReminderHarness['basePayload'];
type FreshCommandFixture = Pick<
  OperatorReminderHarness,
  'claudeQueryMock' | 'handleRemoteExecute'
> & {
  current: () => { payload: Payload; prompts: string[] };
  mockClaudeTurn: (sessionId?: string) => void;
  agentScripts: (
    runtime: AgentRuntime,
    scripts: Script[],
  ) => { sent: AgentTurn[]; send: (message: string, turn?: Partial<Payload>) => Promise<void> };
};

/** A slash command on a session that starts fresh goes out bare, and the transcript it went out
 * without reaches the next turn on the new session. */
function registerFreshCommandTests({
  claudeQueryMock,
  handleRemoteExecute,
  current,
  mockClaudeTurn,
  agentScripts,
}: FreshCommandFixture): void {
  let payload: Payload;
  let prompts: string[];
  beforeEach(() => {
    ({ payload, prompts } = current());
  });

  it('Claude: a command on a fresh session goes out bare, and the next turn reads the chat', async () => {
    mockClaudeTurn('sess-new');
    mockClaudeTurn('sess-new');
    mockClaudeTurn('sess-new');
    await handleRemoteExecute({
      ...payload,
      sessionId: undefined,
      message: '/review',
      history: CHAT,
    });
    const next = { ...payload, sessionId: 'sess-new', history: AFTER_REVIEW };
    await handleRemoteExecute({ ...next, message: 'fix it' });
    await handleRemoteExecute({ ...next, message: 'thanks' });

    expect(prompts[0]).toBe('/review');
    expect(timesIn(prompts[1], '<conversation_history>')).toBe(1);
    expect(prompts[1]).toContain('Human: first question');
    expect(prompts[1]).toContain('Human: second question');
    expect(prompts[1]).not.toContain('review notes');
    expect(prompts[1].endsWith('fix it')).toBe(true);
    expect(prompts[2]).toBe('thanks');
  });

  it('Claude: a command retried fresh after a failed resume goes out bare, and the next turn reads the chat', async () => {
    // biome-ignore lint/correctness/useYield: intentional — throw on first next() like production SDK
    claudeQueryMock.mockImplementationOnce(async function* () {
      throw new Error(
        'Claude Code returned an error result: No conversation found with session ID: stale-cmd',
      );
    });
    mockClaudeTurn('sess-retry');
    mockClaudeTurn('sess-retry');
    await handleRemoteExecute({
      ...payload,
      sessionId: 'stale-cmd',
      message: '/review',
      history: CHAT,
    });
    await handleRemoteExecute({
      ...payload,
      sessionId: 'sess-retry',
      message: 'fix it',
      history: AFTER_REVIEW,
    });

    expect(prompts[0]).toBe('/review');
    expect(timesIn(prompts[1], '<conversation_history>')).toBe(1);
    expect(prompts[1]).toContain('Human: second question');
  });

  it('Claude: a failed resume on the replay turn seeds the whole chat once, not the replay inside it', async () => {
    mockClaudeTurn('sess-new');
    // biome-ignore lint/correctness/useYield: intentional — throw on first next() like production SDK
    claudeQueryMock.mockImplementationOnce(async function* () {
      throw new Error(
        'Claude Code returned an error result: No conversation found with session ID: sess-new',
      );
    });
    mockClaudeTurn('sess-retry');
    await handleRemoteExecute({
      ...payload,
      sessionId: undefined,
      message: '/review',
      history: CHAT,
    });
    await handleRemoteExecute({
      ...payload,
      sessionId: 'sess-new',
      message: 'fix it',
      history: AFTER_REVIEW,
    });

    expect(timesIn(prompts[1], '<conversation_history>')).toBe(1);
    expect(prompts[1]).toContain('Assistant: review notes');
    expect(prompts[1].endsWith('fix it')).toBe(true);
  });

  it('Claude: a command that resumed its session owes nothing', async () => {
    mockClaudeTurn();
    mockClaudeTurn();
    await handleRemoteExecute({ ...payload, message: '/review', history: CHAT });
    await handleRemoteExecute({ ...payload, message: 'fix it', history: AFTER_REVIEW });

    expect(prompts).toEqual(['/review', 'fix it']);
  });

  it('Claude: /clear after a fresh command owes nothing, though no prompt hook takes it', async () => {
    mockClaudeTurn('sess-new');
    // A local command: the CLI reads it and settles, and the prompt hook never fires.
    claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
      const queued = await input.prompt[Symbol.asyncIterator]().next();
      prompts.push(String(queued.value?.message.content));
      yield* turnEnd('sess-newer');
    });
    mockClaudeTurn('sess-newer');
    await handleRemoteExecute({
      ...payload,
      sessionId: undefined,
      message: '/review',
      history: CHAT,
    });
    await handleRemoteExecute({
      ...payload,
      sessionId: 'sess-new',
      message: '/clear',
      history: CHAT,
    });
    await handleRemoteExecute({
      ...payload,
      sessionId: 'sess-newer',
      message: 'hi',
      history: CHAT,
    });

    expect(prompts).toEqual(['/review', '/clear', 'hi']);
  });

  it.each(AGENT_RUNTIMES)(
    '%s: a slash-shaped message on a session the agent lost is seeded like any other, owing nothing',
    async (runtime) => {
      const { sent, send } = agentScripts(runtime, [answersOn('agent-new'), answers]);

      await send('/review', { history: CHAT });
      await send('fix it', { history: AFTER_REVIEW, sessionId: 'agent-new' });

      expect(sent[0].freshSessionFallbackPrompt).toContain('Human: second question');
      expect(sent[0].freshSessionFallbackPrompt?.endsWith('/review')).toBe(true);
      expect(sent[1].prompt).not.toContain('<conversation_history>');
      expect(sent[1].prompt.endsWith('fix it')).toBe(true);
    },
  );

  it.each(AGENT_RUNTIMES)(
    '%s: a command that resumed its session owes nothing',
    async (runtime) => {
      const { sent, send } = agentScripts(runtime, [answers, answers]);

      await send('/review', { history: CHAT });
      await send('fix it', { history: AFTER_REVIEW });

      expect(sent[1].prompt).not.toContain('<conversation_history>');
      expect(sent[1].prompt.endsWith('fix it')).toBe(true);
    },
  );
}
