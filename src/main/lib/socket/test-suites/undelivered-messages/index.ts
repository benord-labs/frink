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
const TURN_END = [
  { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-resumed' } }] },
  { type: 'result' },
];
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

/** An agent turn that answers and finishes. */
async function* answers(): AsyncGenerator<UIMessageChunk, void, undefined> {
  yield REPLY;
  yield { type: 'finish', messageMetadata: { sessionId: 'agent-session' } };
}
type Overrides = Parameters<OperatorReminderHarness['handleRemoteExecute']>[1];
type Execution = ReturnType<OperatorReminderHarness['handleRemoteExecute']>;

/** Runs each agent turn through the next script, keeping what the agent was sent. */
function scriptAgentTurns(
  runtime: AgentRuntime,
  scripts: Script[],
  execute: (message: string, overrides: Overrides) => Execution,
) {
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
  const send = (message: string) => execute(message, overrides);
  return { sent, send, overrides };
}

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

  /** One CLI that reads its prompt, takes it through the prompt hook and ends the turn. A local
   * command, such as `/clear`, runs without the prompt hook ever firing. */
  const mockClaudeTurn = (localCommand = false) =>
    claudeQueryMock.mockImplementationOnce(async function* (input: ClaudeQueryInput) {
      const queued = await input.prompt[Symbol.asyncIterator]().next();
      const text = String(queued.value?.message.content);
      prompts.push(text);
      if (!localCommand) await userPromptSubmitReminder(input, text);
      yield* TURN_END;
    });

  /** A turn the user stops while Frink is still preparing it, before any agent sees the prompt. */
  const stoppedWhilePreparing = async (
    turn: typeof payload,
    overrides?: Overrides,
    message = STOPPED,
  ) => {
    vi.mocked(getMultiProjectContext).mockImplementationOnce(async () => {
      handleRemoteStop(turn);
      return { promptPrefix: '', dynamicChatMcpUrl: null };
    });
    await handleRemoteExecute({ ...turn, message }, overrides);
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

  it('Claude: a /clear, even after a mention, forgets a stopped message for the cleared session', async () => {
    await stoppedWhilePreparing(payload);
    mockClaudeTurn(true);
    mockClaudeTurn();
    await handleRemoteExecute({ ...payload, message: '@[file:editor:a.ts] /clear' });
    await handleRemoteExecute({ ...payload, message: 'hi' });
    expect(prompts).toEqual(['/clear', 'hi']);
  });

  it('Claude: a /clear stopped before the CLI ran it keeps the stopped message owed', async () => {
    await stoppedWhilePreparing(payload);
    await stoppedWhilePreparing(payload, undefined, '/clear');
    mockClaudeTurn();
    await handleRemoteExecute({ ...payload, message: 'hi' });
    expect(prompts[0]).toContain(CARRIED);
  });

  it('Claude: a /clear behind a fresh transcript is text, so the stopped message stays owed', async () => {
    await stoppedWhilePreparing(payload);
    mockClaudeTurn();
    mockClaudeTurn();
    const fresh = { ...payload, sessionId: undefined, history: HISTORY };
    await handleRemoteExecute({ ...fresh, message: '/clear' });
    await handleRemoteExecute({ ...payload, message: 'hi' });
    expect(prompts[0]).toContain('Continue the conversation');
    expect(prompts[1]).toContain(CARRIED);
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

  const agentScripts = (runtime: AgentRuntime, scripts: Script[]) =>
    scriptAgentTurns(runtime, scripts, (message, overrides) =>
      handleRemoteExecute(
        { ...payload, message, history: HISTORY, sessionId: 'agent-session' },
        overrides,
      ),
    );

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

  it('codex: /clear is an ordinary message there, so a stopped message is still carried', async () => {
    const { sent, send, overrides } = agentScripts('codex', [answers, answers]);

    await stoppedWhilePreparing({ ...payload, sessionId: 'agent-session' }, overrides);
    await send('/clear');
    await send('hi');

    expect(sent[0].prompt).not.toContain(STOPPED);
    expect(sent[1].prompt).toContain(CARRIED);
  });

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
}
