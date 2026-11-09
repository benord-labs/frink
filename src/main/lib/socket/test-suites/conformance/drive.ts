import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { expect, onTestFinished, vi } from 'vitest';
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
import { releaseWakeHold } from '../../claude-wake-hold';
import * as socketClient from '../../client';
import type { FileChangedEvent } from '../../execution/tool-effects';
import { mockQuery, never, wakingCli } from '../claude-query-fake';
import { credential } from '../composer-context/delivery';
import type { OperatorReminderHarness } from '../operator-reminders/delivery';
import { CLAUDE_REPLY, type VendorTurns } from './fixtures';

type ExecuteOverrides = NonNullable<Parameters<OperatorReminderHarness['handleRemoteExecute']>[1]>;

/** What one turn sent out: its stream, its editor-tab refreshes, and how it ended. */
export type Observed = {
  subChatId: string;
  chunks: UIMessageChunk[];
  fileChanged: FileChangedEvent[];
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

/** Claude's CLI plays the SDK frames through the real transformer, then stays open as it does. */
function driveClaude(frames: VendorTurns['claude'], h: OperatorReminderHarness): ExecuteOverrides {
  transformerMock.mockImplementation(realTransformer);
  mockQuery(h.claudeQueryMock, async function* ({ prompt }) {
    await prompt.next();
    yield* frames;
    await never();
  });
  return {};
}

function driveCodex(notifications: VendorTurns['codex']): ExecuteOverrides {
  const chunks = notifications.flatMap((args) => mapNotificationToChunks(...args));
  vi.mocked(runCodexAgent).mockImplementationOnce(() => runnerStream(chunks));
  return {};
}

/** How each runtime's translator output reaches the executor, through the seam it already has. */
type Drivers = {
  [R in AgentRuntime]: (turn: VendorTurns[R], h: OperatorReminderHarness) => ExecuteOverrides;
};

const DRIVERS: Drivers = {
  claude: driveClaude,
  codex: driveCodex,
  acp: (turn) => ({ startAcpTurn: () => runnerStream(acpChunks(turn)) }),
  copilot: (events) => ({ startCopilotTurn: () => runnerStream(copilotChunks(events)) }),
  cursor: (messages) => ({ startCursorTurn: () => runnerStream(cursorChunks(messages)) }),
};

/** A live window whose `webContents.send` is spied, standing in for an open editor. */
function spyEditorWindow() {
  const webContents = {
    isCrashed: () => false,
    send(_channel: string, _payload: FileChangedEvent): void {},
  };
  // SAFETY: the file-changed broadcast reads only isDestroyed, webContents.isCrashed and
  // webContents.send from each window.
  windowsMock.mockReturnValue([{ isDestroyed: () => false, webContents } as BrowserWindow]);
  return vi.spyOn(webContents, 'send');
}

/** One sub-chat on `runtime` with a spied editor window: run its turn, then read what it sent. */
function startRow(h: OperatorReminderHarness, runtime: AgentRuntime) {
  const subChatId = randomUUID();
  restoreSuiteMocksAfterTest();
  const send = spyEditorWindow();
  return {
    subChatId,
    async execute(overrides: ExecuteOverrides): Promise<void> {
      await h.handleRemoteExecute(
        { ...h.basePayload, subChatId, message: 'conformance turn' },
        { ...overrides, runtimeFor: () => runtime },
      );
      // Non-Claude completions are sent on the next tick.
      await new Promise((resolve) => setImmediate(resolve));
    },
    observe(): Observed {
      const sent = vi.mocked(socketClient.sendStreamChunkDirect).mock.calls.map(([p]) => p);
      const completed = vi
        .mocked(socketClient.sendExecuteCompleteDirect)
        .mock.calls.map(([p]) => p);
      const errors = vi.mocked(socketClient.sendErrorDirect).mock.calls.map(([p]) => p);
      return {
        subChatId,
        // SAFETY: every turn loop in the executor streams UIMessageChunk values only.
        chunks: forSubChat(sent, subChatId).map((payload) => payload.chunk as UIMessageChunk),
        fileChanged: send.mock.calls.flatMap(([channel, payload]) =>
          channel === 'file-changed' ? [payload] : [],
        ),
        completed: forSubChat(completed, subChatId).length > 0,
        errors: forSubChat(errors, subChatId).map((payload) => payload.error),
      };
    },
  };
}

/** Runs one turn on `runtime` through handleRemoteExecute, fed by its own translator's output. */
export async function runConformanceTurn<R extends AgentRuntime>(
  h: OperatorReminderHarness,
  runtime: R,
  turn: VendorTurns[R],
): Promise<Observed> {
  const row = startRow(h, runtime);
  const provider = PROVIDER_FOR[runtime];
  if (provider) vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(credential(provider));
  await row.execute(DRIVERS[runtime](turn, h));
  return row.observe();
}

/** Claude replies and holds on running background work; a wake then plays `burst` into that reply. */
export async function runClaudeWakeBurst(
  h: OperatorReminderHarness,
  burst: VendorTurns['claude'],
): Promise<Observed> {
  const row = startRow(h, 'claude');
  transformerMock.mockImplementation(realTransformer);
  const cli = wakingCli(CLAUDE_REPLY, async function* () {
    yield* burst;
  });
  mockQuery(h.claudeQueryMock, cli.script);
  onTestFinished(() => releaseWakeHold(row.subChatId, 'test cleanup'));
  await row.execute({});
  cli.wake();
  await vi.waitFor(() => expect(burstCompleted(row.subChatId)).toBe(true));
  return row.observe();
}

/** Whether a wake burst on `subChatId` has been persisted. */
function burstCompleted(subChatId: string): boolean {
  return vi
    .mocked(socketClient.sendExecuteCompleteDirect)
    .mock.calls.some(([payload]) => payload.subChatId === subChatId && payload.wakeBurst === true);
}

function forSubChat<P extends { subChatId: string }>(payloads: P[], subChatId: string): P[] {
  return payloads.filter((payload) => payload.subChatId === subChatId);
}
