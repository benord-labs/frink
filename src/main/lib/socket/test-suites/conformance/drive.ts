import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { onTestFinished, vi } from 'vitest';
import type { AgentRuntime, AiProviderId } from '../../../../../shared/lib/ai-providers';
import { runCodexAgent } from '../../../agent-runner';
import type { RecordedTurn } from '../../../agent-runner/acp/acp-test-fixtures';
import {
  createAcpTurnState,
  mapPromptResponse,
  mapSessionUpdate,
} from '../../../agent-runner/acp/acp-updates';
import { ChunkQueue } from '../../../agent-runner/codex/chunk-queue';
import { mapNotificationToChunks } from '../../../agent-runner/codex/codex-events';
import { completeTurnChunks, makeChunkSink } from '../../../agent-runner/codex/codex-stream-chunks';
import {
  createCopilotEventState,
  mapCopilotEvent,
} from '../../../agent-runner/copilot/copilot-events';
import {
  createCursorEventState,
  mapCursorMessage,
} from '../../../agent-runner/cursor/cursor-events';
import { createTransformer } from '../../../claude';
import { createThinkingEmitter } from '../../../claude/thinking-emitter';
// executor.test.ts mocks only the claude barrel, so this is the real SDK-to-chunk transformer.
import { createTransformer as realTransformer } from '../../../claude/transform';
import type { UIMessageChunk } from '../../../claude/types';
import { getDefaultClaudeCodeToken } from '../../../credentials';
import { listLinkedProjects } from '../../../db/repos/chat-linked-projects';
import { getChatWithProjectAccount } from '../../../db/repos/chats';
import * as toolValidation from '../../../permissions/tool-validation';
import * as socketClient from '../../client';
import type { MessageDelivery } from '../../execution/message-provenance/origin';
import { userPromptSubmitReminder } from '../../test-utils';
import { mockQuery, never } from '../claude-query-fake';
import { credential } from '../composer-context/delivery';
import type { OperatorReminderHarness } from '../operator-reminders/delivery';
import type { VendorTurns } from './fixtures';

type ExecuteOverrides = NonNullable<Parameters<OperatorReminderHarness['handleRemoteExecute']>[1]>;
type FileChanged = { filePath: string; type: string; subChatId: string };

/** The chat's worktree and linked projects, and the message and how it was sent. By default: no
 * worktree, no links, and a plain message with no origin. */
export type TurnSetup = {
  /** The worktree the chat runs in, and the main checkout its permissions are judged against. */
  worktree?: { path: string; main: string };
  links?: Array<{ name: string; path: string }>;
  message?: string;
  delivery?: MessageDelivery;
};

/** What one turn sent out: its stream, its notes, its editor-tab refreshes, and how it ended. */
export type Observed = {
  subChatId: string;
  chunks: UIMessageChunk[];
  /** What the runtime's context channel carried beside the prompt, as its own seam took it. */
  notes: string[];
  fileChanged: FileChanged[];
  completed: boolean;
  errors: string[];
};

/** The account each runtime runs under; Claude keeps the executor suite's own account. */
const PROVIDER_FOR: Partial<Record<AgentRuntime, AiProviderId>> = {
  codex: 'codex',
  acp: 'opencode',
  copilot: 'copilot',
  cursor: 'cursor',
};

const transformerMock = vi.mocked(createTransformer);
const windowsMock = vi.mocked(BrowserWindow.getAllWindows);

/** A row swaps in the real transformer and a spied window; this puts the suite's own back after. */
function restoreSuiteMocksAfterTest(): void {
  const transformer = transformerMock.getMockImplementation();
  const windows = windowsMock.getMockImplementation();
  onTestFinished(() => {
    transformerMock.mockReset();
    windowsMock.mockReset();
    if (transformer) transformerMock.mockImplementation(transformer);
    if (windows) windowsMock.mockImplementation(windows);
  });
}

/** Frames translator output the way the Codex, ACP, Copilot and Cursor runners all do. */
async function* runnerStream(
  chunks: UIMessageChunk[],
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const queue = new ChunkQueue();
  const openTextIds = new Set<string>();
  const thinking = createThinkingEmitter();
  chunks.forEach(makeChunkSink(queue, openTextIds, thinking));
  queue.finish();
  yield { type: 'start' };
  yield* queue.drain();
  yield* completeTurnChunks(thinking, openTextIds);
  yield { type: 'finish' };
}

function acpChunks({ messages, response }: RecordedTurn): UIMessageChunk[] {
  const state = createAcpTurnState();
  const updates = messages.flatMap((message) =>
    'update' in message ? mapSessionUpdate(message.update, state) : [],
  );
  return [...updates, ...mapPromptResponse(response)];
}

function copilotChunks(events: VendorTurns['copilot']): UIMessageChunk[] {
  const state = createCopilotEventState();
  return events.flatMap((event) => mapCopilotEvent(event, state));
}

function cursorChunks(messages: VendorTurns['cursor']): UIMessageChunk[] {
  const state = createCursorEventState();
  return messages.flatMap((message) => mapCursorMessage(message, state));
}

/** Claude's CLI plays the SDK frames through the real transformer, then stays open as it does.
 * Its prompt hook fires as the CLI reads the prompt, adding the turn's notes. */
function driveClaude(
  frames: VendorTurns['claude'],
  h: OperatorReminderHarness,
  notes: string[],
): ExecuteOverrides {
  transformerMock.mockImplementation(realTransformer);
  mockQuery(h.claudeQueryMock, async function* ({ prompt, options }) {
    await prompt.next();
    const context = await userPromptSubmitReminder({ options });
    if (context) notes.push(context);
    yield* frames;
    await never();
  });
  return {};
}

function driveCodex(
  notifications: VendorTurns['codex'],
  _h: OperatorReminderHarness,
  notes: string[],
): ExecuteOverrides {
  const chunks = notifications.flatMap((args) => mapNotificationToChunks(...args));
  vi.mocked(runCodexAgent).mockImplementationOnce(({ composerContext = {} }) => {
    notes.push(...Object.values(composerContext).map((entry) => entry.value));
    return runnerStream(chunks);
  });
  return {};
}

/** An ACP, Copilot or Cursor turn: it takes the notes with its other params. */
function runnerTurn(chunks: UIMessageChunk[], notes: string[]) {
  return ({ composerNotes }: { composerNotes: string[] }) => {
    notes.push(...composerNotes);
    return runnerStream(chunks);
  };
}

/** How each runtime's translator output reaches the executor, through the seam it already has. */
type Drivers = {
  [R in AgentRuntime]: (
    turn: VendorTurns[R],
    h: OperatorReminderHarness,
    notes: string[],
  ) => ExecuteOverrides;
};

const DRIVERS: Drivers = {
  claude: driveClaude,
  codex: driveCodex,
  acp: (turn, _h, notes) => ({ startAcpTurn: runnerTurn(acpChunks(turn), notes) }),
  copilot: (events, _h, notes) => ({ startCopilotTurn: runnerTurn(copilotChunks(events), notes) }),
  cursor: (messages, _h, notes) => ({
    startCursorTurn: runnerTurn(cursorChunks(messages), notes),
  }),
};

/** The chat row the turn reads, its worktree, and the projects linked to it. */
function seedChat(chatId: string, { worktree, links = [] }: TurnSetup): void {
  // SAFETY: the executor reads only the chat's id, task, worktree and branch, and its account.
  vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
    chat: { id: chatId, worktreePath: worktree?.path },
    account: null,
  } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
  if (worktree) {
    vi.spyOn(toolValidation, 'resolvePermissionProjectPath').mockReturnValueOnce(worktree.main);
  }
  // SAFETY: the chat's workspace reads only each linked project's name and path.
  vi.mocked(listLinkedProjects).mockReturnValueOnce(links as ReturnType<typeof listLinkedProjects>);
}

/** A window whose `webContents.send` is spied, standing in for an open editor. */
function spyEditorWindow() {
  const webContents = { send(_channel: string, _payload: FileChanged): void {} };
  // SAFETY: the file-changed broadcast reads only webContents.send from each window.
  windowsMock.mockReturnValue([{ webContents } as BrowserWindow]);
  return vi.spyOn(webContents, 'send');
}

/** Runs one turn on `runtime` through handleRemoteExecute, fed by its own translator's output. */
export async function runConformanceTurn<R extends AgentRuntime>(
  h: OperatorReminderHarness,
  runtime: R,
  turn: VendorTurns[R],
  setup: TurnSetup = {},
): Promise<Observed> {
  const subChatId = randomUUID();
  restoreSuiteMocksAfterTest();
  const send = spyEditorWindow();
  const provider = PROVIDER_FOR[runtime];
  if (provider) vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(credential(provider));
  seedChat(h.basePayload.chatId, setup);
  const notes: string[] = [];
  const overrides = DRIVERS[runtime](turn, h, notes);
  const { message = 'conformance turn', delivery } = setup;
  await h.handleRemoteExecute(
    { ...h.basePayload, subChatId, message, delivery },
    { ...overrides, runtimeFor: () => runtime },
  );
  // Non-Claude completions are sent on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  const sent = vi.mocked(socketClient.sendStreamChunkDirect).mock.calls.map(([p]) => p);
  const completed = vi.mocked(socketClient.sendExecuteCompleteDirect).mock.calls.map(([p]) => p);
  const errors = vi.mocked(socketClient.sendErrorDirect).mock.calls.map(([p]) => p);
  return {
    subChatId,
    // SAFETY: every turn loop in the executor streams UIMessageChunk values only.
    chunks: forSubChat(sent, subChatId).map((payload) => payload.chunk as UIMessageChunk),
    notes,
    fileChanged: send.mock.calls.flatMap(([channel, payload]) =>
      channel === 'file-changed' ? [payload] : [],
    ),
    completed: forSubChat(completed, subChatId).length > 0,
    errors: forSubChat(errors, subChatId).map((payload) => payload.error),
  };
}

function forSubChat<P extends { subChatId: string }>(payloads: P[], subChatId: string): P[] {
  return payloads.filter((payload) => payload.subChatId === subChatId);
}
