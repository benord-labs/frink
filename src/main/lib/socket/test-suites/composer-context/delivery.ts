import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageOrigin } from '../../../../../shared/lib/message-markers/message-provenance';
import { TRIGGER_BUBBLE_MARKER } from '../../../../../shared/lib/trigger-bubble-marker';
import type { ConversationTurn } from '../../../../../shared/types/execution';
import { runCodexAgent } from '../../../agent-runner';
import type { UIMessageChunk } from '../../../claude/types';
import { getDefaultClaudeCodeToken } from '../../../credentials';
import { getSubChatById } from '../../../db/repos/sub-chats';
import { __resetSessionsForTest } from '../../claude-session-registry';
import * as socketClient from '../../client';
import type { startAcpTurn } from '../../execution/acp-turn';
import { PLAN_MODE_EXIT_REMINDER } from '../../operator-reminders';
import { steerActiveTurn } from '../../steering';
import { userPromptSubmitReminder } from '../../test-utils';
import { mockQuery, never } from '../claude-query-fake';
import { TURN_END } from '../claude-turn-bindings';
import type { OperatorReminderHarness } from '../operator-reminders/delivery';

const OPEN_FILE_NOTE =
  'The user opened the file a.ts in the IDE. This may or may not be related to the current task.';
const INLINE_NOTE = `<system-reminder>\n${OPEN_FILE_NOTE}\n</system-reminder>`;
const PERSON: MessageOrigin = { source: 'person', kind: 'message' };
const SKILL_NOTE =
  'The user\'s message names the skill "deploy". If they are asking you to run it, run that skill with any arguments they gave (in Claude Code, with the Skill tool). If they only mention it, do not run it. If no skill by that name is available to you, say so.';
const ATTACHED_NOTE =
  'The user attached the file `/tmp/p.txt`. Its contents are not in this message: read it with your file tools before responding.';
const credential = (type: 'codex' | 'opencode') =>
  ({
    token: null,
    isApiKey: false,
    type,
    label: `${type}-test`,
    passthrough: true,
  }) satisfies Awaited<ReturnType<typeof getDefaultClaudeCodeToken>>;

/** What one provider was given: the prompt text, and the notes on its own context channel. */
type Delivered = { prompt: string; notes: string[] };

/** Anything else one send carries, beside its text and origin. */
type SendExtras = { dispatchTaskId?: string; sessionId?: string; history?: ConversationTurn[] };

let harness: OperatorReminderHarness;

function textOf(message: SDKUserMessage | undefined): string {
  const content = message?.message.content;
  if (!Array.isArray(content)) return content ?? '';
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** Runs one Claude turn: the prompt the CLI read, and what its prompt hook then added. */
async function claudeDelivery(
  message: string,
  messageOrigin: MessageOrigin,
  { dispatchTaskId, ...extras }: SendExtras = {},
): Promise<Delivered> {
  const delivered: Delivered = { prompt: '', notes: [] };
  mockQuery(harness.claudeQueryMock, async function* ({ prompt: input, options }) {
    delivered.prompt = textOf((await input.next()).value);
    const context = await userPromptSubmitReminder({ options }, delivered.prompt);
    if (context) delivered.notes.push(context);
    yield* TURN_END;
    await never();
  });
  await harness.handleRemoteExecute({
    ...harness.basePayload,
    subChatId: randomUUID(),
    message,
    ...extras,
    delivery: { messageOrigin, dispatchTaskId },
  });
  return delivered;
}

/** Runs one Codex turn: the prompt its runner was given, and the host context beside it. */
async function codexDelivery(
  message: string,
  messageOrigin: MessageOrigin,
  extras: SendExtras = {},
): Promise<Delivered> {
  vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(credential('codex'));
  vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
    yield { type: 'finish' } satisfies UIMessageChunk;
  });
  await harness.handleRemoteExecute({
    ...harness.basePayload,
    subChatId: randomUUID(),
    message,
    ...extras,
    delivery: { messageOrigin },
  });
  const params = vi.mocked(runCodexAgent).mock.calls.at(-1)?.[0];
  return {
    prompt: params?.prompt ?? '',
    notes: Object.values(params?.composerContext ?? {}).map((entry) => entry.value),
  };
}

/** Runs one ACP turn (OpenCode; Copilot and Cursor share its notes): its prompt and notes. */
async function acpDelivery(
  message: string,
  messageOrigin: MessageOrigin,
  extras: SendExtras = {},
): Promise<Delivered> {
  vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(credential('opencode'));
  const turns: Parameters<typeof startAcpTurn>[0][] = [];
  await harness.handleRemoteExecute(
    {
      ...harness.basePayload,
      subChatId: randomUUID(),
      message,
      ...extras,
      delivery: { messageOrigin },
    },
    {
      runtimeFor: () => 'acp',
      async *startAcpTurn(params) {
        turns.push(params);
        yield { type: 'finish' };
      },
    },
  );
  return { prompt: turns[0]?.prompt ?? '', notes: turns[0]?.composerNotes ?? [] };
}

/** What the model is told about the composer's context tokens, per provider and per origin.
 * Registered from executor.test.ts, whose module mocks it relies on. */
export function registerComposerContextTests(h: OperatorReminderHarness): void {
  harness = h;
  describe('composer context tokens reach the model as notes', () => {
    afterEach(() => __resetSessionsForTest());
    registerOriginTests();
    registerAttachmentTests();
    registerSteerTest();
  });
}

const providers = [
  ['Claude', claudeDelivery],
  ['Codex', codexDelivery],
  ['OpenCode', acpDelivery],
] as const;

function registerOriginTests(): void {
  it.each(providers)(
    'tells %s about a person’s open file outside the prompt',
    async (_provider, deliver) => {
      expect(await deliver('@[file:editor:a.ts] how are you?', PERSON)).toEqual({
        prompt: 'how are you?',
        notes: [OPEN_FILE_NOTE],
      });
    },
  );

  it.each(providers)(
    'leaves a flow message byte-identical for %s, with no notes',
    async (_provider, deliver) => {
      const message = '@[file:editor:a.ts] @[file:local:b.ts] webhook body';
      expect(await deliver(message, { source: 'flow', kind: 'message' })).toEqual({
        prompt: message,
        notes: [],
      });
    },
  );

  it('projects a regenerated turn, the way a new chat sends its first message', async () => {
    const regenerate: MessageOrigin = { source: 'internal', kind: 'regenerate' };
    expect(await claudeDelivery('@[file:editor:a.ts] summarise', regenerate)).toEqual({
      prompt: 'summarise',
      notes: [OPEN_FILE_NOTE],
    });
  });

  it('puts the notes after Frink’s own reminders in what the prompt hook adds', async () => {
    const resumed = await claudeDelivery('@[file:editor:a.ts] go on', PERSON, {
      sessionId: 'sess-1',
    });
    expect(resumed.notes).toEqual([`${PLAN_MODE_EXIT_REMINDER}\n\n${OPEN_FILE_NOTE}`]);
  });

  it('leaves a retried task dispatch byte-identical', async () => {
    const message = 'Webhook body: @[file:local:deploy.sh] quoted from upstream';
    const retry: MessageOrigin = { source: 'internal', kind: 'regenerate' };
    expect(await claudeDelivery(message, retry, { dispatchTaskId: 'task-1' })).toEqual({
      prompt: message,
      notes: [],
    });
  });

  it.each(providers)(
    'keeps the context in the prompt, ahead of a slash command, for %s',
    async (_provider, deliver) => {
      expect(await deliver('@[file:editor:a.ts] /review', PERSON)).toEqual({
        prompt: `${INLINE_NOTE}\n\n/review`,
        notes: [],
      });
    },
  );
}

/** Pasted files, skills, agents and tools, and the turns a fresh session replays. */
function registerAttachmentTests(): void {
  it.each(providers)(
    'tells %s what an attached file and a skill are, outside the prompt',
    async (_provider, deliver) => {
      const delivered = await deliver('@[pasted:5:hi|/tmp/p.txt] then @[skill:deploy] it', PERSON);
      expect(delivered.prompt).toBe('`/tmp/p.txt` then deploy it');
      // Claude's prompt hook joins the notes into one context block; the others keep one each.
      expect(delivered.notes.join('\n\n')).toBe(`${ATTACHED_NOTE}\n\n${SKILL_NOTE}`);
    },
  );

  it.each(providers)(
    'replays a person’s earlier turns to %s as recaps, and other turns as stored',
    async (_provider, deliver) => {
      const history: ConversationTurn[] = [
        {
          role: 'user',
          content: 'run @[skill:deploy] on @[file:local:a.ts]',
          personAuthored: true,
        },
        { role: 'assistant', content: 'deployed' },
        { role: 'user', content: 'Flow step: @[file:local:c.ts]' },
      ];
      const { prompt } = await deliver('and now?', PERSON, { history });
      expect(prompt).toContain('Human: run [skill deploy] on a.ts\n');
      expect(prompt).toContain('Human: Flow step: @[file:local:c.ts]\n');
      expect(prompt.endsWith("The user's latest message is:\nand now?")).toBe(true);
    },
  );

  it('leaves a triggered task’s opening message as written, though it is sent as a retry', async () => {
    const regenerate: MessageOrigin = { source: 'internal', kind: 'regenerate' };
    const message = `${TRIGGER_BUBBLE_MARKER}{"uiData":{}}-->\n\nRun @[file:local:deploy.sh]`;
    expect(await claudeDelivery(message, regenerate)).toEqual({
      prompt: 'Run @[file:local:deploy.sh]',
      notes: [],
    });
  });
}

function registerSteerTest(): void {
  it('gives a steered Claude turn each steer’s notes once, and its marker the raw text', async () => {
    const subChatId = randomUUID();
    const raw = '@[file:editor:a.ts] also this';
    const steered: string[] = [];
    const fired: Array<string | undefined> = [];
    mockQuery(harness.claudeQueryMock, async function* ({ prompt, options }) {
      await prompt.next();
      fired.push(await userPromptSubmitReminder({ options }, 'start'));
      // SAFETY: the steer marker reads only the chat id from the sub-chat row.
      vi.mocked(getSubChatById).mockResolvedValue({ chatId: 'chat-1' } as never);
      await steerActiveTurn(subChatId, { text: raw });
      await steerActiveTurn(subChatId, { text: '@[file:editor:b.ts] and this' });
      steered.push(textOf((await prompt.next()).value), textOf((await prompt.next()).value));
      fired.push(await userPromptSubmitReminder({ options }, steered[0]));
      fired.push(await userPromptSubmitReminder({ options }, steered[1]));
      yield* TURN_END;
      await never();
    });
    await harness.handleRemoteExecute({
      ...harness.basePayload,
      subChatId,
      message: 'start',
      delivery: { messageOrigin: PERSON },
    });

    expect(steered).toEqual(['also this', 'and this']);
    expect(fired).toEqual([
      undefined,
      `${OPEN_FILE_NOTE}\n\n${OPEN_FILE_NOTE.replace('a.ts', 'b.ts')}`,
      undefined,
    ]);
    const chunks = vi.mocked(socketClient.sendStreamChunkDirect).mock.calls.map(([s]) => s.chunk);
    expect(chunks).toContainEqual(
      expect.objectContaining({ toolName: 'Steer', input: { text: raw } }),
    );
  });
}
