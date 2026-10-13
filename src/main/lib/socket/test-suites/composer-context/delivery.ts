import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageOrigin } from '../../../../../shared/lib/message-markers/message-provenance';
import { runCodexAgent } from '../../../agent-runner';
import type { UIMessageChunk } from '../../../claude/types';
import { getDefaultClaudeCodeToken } from '../../../credentials';
import { getSubChatById } from '../../../db/repos/sub-chats';
import { __resetSessionsForTest } from '../../claude-session-registry';
import * as socketClient from '../../client';
import { steerActiveTurn } from '../../steering';
import { mockQuery, never } from '../claude-query-fake';
import { TURN_END } from '../claude-turn-bindings';
import type { OperatorReminderHarness } from '../operator-reminders/delivery';

const OPEN_FILE_NOTE =
  '<system-reminder>\nThe user opened the file a.ts in the IDE. This may or may not be related to the current task.\n</system-reminder>';
const PERSON: MessageOrigin = { source: 'person', kind: 'message' };
const CODEX_CREDENTIAL: Awaited<ReturnType<typeof getDefaultClaudeCodeToken>> = {
  token: null,
  isApiKey: false,
  type: 'codex',
  label: 'codex-test',
  passthrough: true,
};

let harness: OperatorReminderHarness;

function textOf(message: SDKUserMessage | undefined): string {
  const content = message?.message.content;
  if (!Array.isArray(content)) return content ?? '';
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** Runs one Claude turn and returns the prompt the CLI read. */
async function claudePrompt(
  message: string,
  messageOrigin: MessageOrigin,
  dispatchTaskId?: string,
): Promise<string> {
  let prompt = '';
  mockQuery(harness.claudeQueryMock, async function* ({ prompt: input }) {
    prompt = textOf((await input.next()).value);
    yield* TURN_END;
    await never();
  });
  await harness.handleRemoteExecute({
    ...harness.basePayload,
    subChatId: randomUUID(),
    message,
    delivery: { messageOrigin, dispatchTaskId },
  });
  return prompt;
}

/** Runs one Codex turn and returns the prompt its runner was given. */
async function codexPrompt(message: string, messageOrigin: MessageOrigin): Promise<string> {
  vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(CODEX_CREDENTIAL);
  vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
    yield { type: 'finish' } satisfies UIMessageChunk;
  });
  await harness.handleRemoteExecute({
    ...harness.basePayload,
    subChatId: randomUUID(),
    message,
    delivery: { messageOrigin },
  });
  return vi.mocked(runCodexAgent).mock.calls.at(-1)?.[0].prompt ?? '';
}

/** What the model is told about the composer's context tokens, per provider and per origin.
 * Registered from executor.test.ts, whose module mocks it relies on. */
export function registerComposerContextTests(h: OperatorReminderHarness): void {
  harness = h;
  describe('composer context tokens reach the model as notes', () => {
    afterEach(() => __resetSessionsForTest());
    registerOriginTests();
    registerSteerTest();
  });
}

function registerOriginTests(): void {
  it.each([
    ['Claude', claudePrompt],
    ['Codex', codexPrompt],
  ])('projects a person’s message for %s', async (_provider, promptFor) => {
    expect(await promptFor('@[file:editor:a.ts] how are you?', PERSON)).toBe(
      `${OPEN_FILE_NOTE}\n\nhow are you?`,
    );
  });

  it.each([
    ['Claude', claudePrompt],
    ['Codex', codexPrompt],
  ])('leaves a flow message byte-identical for %s', async (_provider, promptFor) => {
    const message = '@[file:editor:a.ts] @[file:local:b.ts] webhook body';
    expect(await promptFor(message, { source: 'flow', kind: 'message' })).toBe(message);
  });

  it('projects a regenerated turn, the way a new chat sends its first message', async () => {
    expect(
      await claudePrompt('@[file:editor:a.ts] summarise', {
        source: 'internal',
        kind: 'regenerate',
      }),
    ).toBe(`${OPEN_FILE_NOTE}\n\nsummarise`);
  });

  it('leaves a retried task dispatch byte-identical', async () => {
    const message = 'Webhook body: @[file:local:deploy.sh] quoted from upstream';
    const retry: MessageOrigin = { source: 'internal', kind: 'regenerate' };
    expect(await claudePrompt(message, retry, 'task-1')).toBe(message);
  });

  it.each([
    ['Claude', claudePrompt],
    ['Codex', codexPrompt],
  ])('keeps the context ahead of a slash command for %s', async (_provider, promptFor) => {
    expect(await promptFor('@[file:editor:a.ts] /review', PERSON)).toBe(
      `${OPEN_FILE_NOTE}\n\n/review`,
    );
  });
}

function registerSteerTest(): void {
  it('steers a Claude turn with the projected text while its marker keeps the raw text', async () => {
    const subChatId = randomUUID();
    const raw = '@[file:editor:a.ts] also this';
    let steered = '';
    mockQuery(harness.claudeQueryMock, async function* ({ prompt }) {
      await prompt.next();
      // SAFETY: the steer marker reads only the chat id from the sub-chat row.
      vi.mocked(getSubChatById).mockResolvedValueOnce({ chatId: 'chat-1' } as never);
      await steerActiveTurn(subChatId, { text: raw });
      steered = textOf((await prompt.next()).value);
      yield* TURN_END;
      await never();
    });
    await harness.handleRemoteExecute({
      ...harness.basePayload,
      subChatId,
      message: 'start',
      delivery: { messageOrigin: PERSON },
    });

    expect(steered).toBe(`${OPEN_FILE_NOTE}\n\nalso this`);
    const chunks = vi.mocked(socketClient.sendStreamChunkDirect).mock.calls.map(([s]) => s.chunk);
    expect(chunks).toContainEqual(
      expect.objectContaining({ toolName: 'Steer', input: { text: raw } }),
    );
  });
}
