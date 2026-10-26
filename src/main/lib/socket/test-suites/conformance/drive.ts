import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BrowserWindow } from 'electron';
import { expect, onTestFinished, vi } from 'vitest';
import type { AgentRuntime, AiProviderId } from '../../../../../shared/lib/ai-providers';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
import { runCodexAgent } from '../../../agent-runner';
import type { RecordedTurn } from '../../../agent-runner/acp/acp-test-fixtures';
import {
  createAcpTurnState,
  mapPromptResponse,
  mapSessionUpdate,
} from '../../../agent-runner/acp/acp-updates';
import { ChunkQueue } from '../../../agent-runner/codex/chunk-queue';
import type { CodexApprovalCheck } from '../../../agent-runner/codex/codex-approvals';
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
import { updateSubChatSession } from '../../../db/repos/sub-chats';
import { releaseWakeHold } from '../../claude-wake-hold';
import * as socketClient from '../../client';
import type { FileChangedEvent } from '../../execution/tool-effects';
import { handleRemoteStop } from '../../executor';
import { getPreToolUseHook, userPromptSubmitReminder } from '../../test-utils';
import { type CliScript, mockQuery, wakingCli } from '../claude-query-fake';
import { credential } from '../composer-context/delivery';
import type { ExecutorPermissionHarness } from '../executor-codex-permissions';
import { hookPromptText, type OperatorReminderHarness } from '../operator-reminders/delivery';
import { CLAUDE_REPLY, SESSION_ID, type VendorTurns } from './fixtures';

type ExecuteOverrides = NonNullable<Parameters<OperatorReminderHarness['handleRemoteExecute']>[1]>;

/** What one turn sent out: its stream, its editor-tab refreshes, and how it ended. */
export type Observed = {
  subChatId: string;
  chunks: UIMessageChunk[];
  fileChanged: FileChangedEvent[];
  completed: boolean;
  /** The text of every reply this sub-chat's completions saved. */
  savedText: string;
  errors: string[];
  /** What the runtime was handed for each turn, in order. */
  inputs: TurnInput[];
  /** The permission cards raised for this sub-chat. */
  cards: PermissionCard[];
  /** The other sub-chat, in a row that runs two at once. */
  peer?: Observed;
};
type PermissionCard = Parameters<typeof socketClient.sendPermissionRequest>[0];

/** The executor suite's harness, plus the answer channel its card sender registered. */
export type GridHarness = OperatorReminderHarness &
  Pick<ExecutorPermissionHarness, 'clientPermissionBridge'>;

/** One turn as the runtime saw it: the session it resumed, all it was told, and how it ended. */
type TurnInput = { resumedFrom?: string; told: string; end: TurnEnd };
/** Whether the runtime was told to stop (its abort, or Claude's `close()`), whether its stream
 * was closed, and its ask's answer. */
type TurnEnd = { readonly stopped: boolean; readonly closed: boolean; allowed?: boolean | null };

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
  yield { type: 'message-metadata', messageMetadata: { sessionId: SESSION_ID } };
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

/** What a row's turn may script beyond its vendor frames. */
type TurnScript = {
  /** Press Stop right after the item that carries this text. */
  stopAfter?: string;
  /** A command the agent asks to run, once `asksOpen` settles, before it replies. */
  ask?: string;
  asksOpen?: Promise<void>;
};
/** A row's state shared by its turns, plus this turn's script. */
type TurnContext = TurnScript & {
  h: GridHarness;
  inputs: TurnInput[];
  claudeTurns: Array<TurnScript & { frames: VendorTurns['claude'] }>;
  stop: () => void;
};

/** Whether a chunk or SDK frame carries `text`: where a row presses Stop. */
const carries = (item: UIMessageChunk | SDKMessage, text: string | undefined) =>
  text !== undefined && JSON.stringify(item).includes(text);

/** A runner stream that asks first if scripted, and presses Stop after the `stopAfter` chunk. */
async function* stoppable(
  stream: AsyncGenerator<UIMessageChunk, void, undefined>,
  { stopAfter, stop, ask, asksOpen }: TurnContext,
  end: { closed: boolean; allowed?: boolean | null },
  check: CodexApprovalCheck,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  try {
    if (ask) {
      await asksOpen;
      end.allowed = (await check({ toolName: 'Bash', input: { command: ask } })).allowed;
    }
    for await (const chunk of stream) {
      yield chunk;
      if (carries(chunk, stopAfter)) stop();
    }
  } finally {
    end.closed = true;
  }
}

/** How a runner handed `signal` ends: told to stop when it aborts, closed when its stream is. */
function stopEnd(signal: AbortSignal | undefined) {
  return {
    closed: false,
    get stopped() {
      return signal?.aborted === true;
    },
  };
}

type CliOptions = Parameters<CliScript>[0]['options'];

/** Asks Frink's real Claude gate to run the scripted command, as the CLI does before Bash. */
async function askClaudeGate(options: CliOptions, { ask, asksOpen }: TurnScript) {
  if (!ask) return undefined;
  await asksOpen;
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ask } };
  const out = await getPreToolUseHook({ options })(input, `ask-${ask}`);
  return 'hookSpecificOutput' in out && out.hookSpecificOutput.permissionDecision === 'allow';
}

/** One prompt as Claude saw it: its hook's reminders, then the prompt. Closing its query stops it
 * and ends its stream at once. */
async function claudeInput(
  options: CliOptions,
  content: Parameters<typeof hookPromptText>[0],
  closed: () => boolean,
): Promise<TurnInput> {
  const text = hookPromptText(content);
  const reminder = await userPromptSubmitReminder({ options }, text);
  const end: TurnEnd = {
    get stopped() {
      return closed();
    },
    get closed() {
      return closed();
    },
  };
  return { told: [reminder, text].join('\n'), end };
}

/** Claude's CLI plays the row's next turn each time it reads a prompt, open between turns. */
function claudeCli(ctx: TurnContext, closed: () => boolean): CliScript {
  return async function* ({ prompt, options }) {
    let session = options.resume;
    for (let read = await prompt.next(); !read.done; read = await prompt.next()) {
      const input = await claudeInput(options, read.value.message.content, closed);
      ctx.inputs.push({ ...input, resumedFrom: session });
      const turn = ctx.claudeTurns.shift() ?? { frames: [] };
      input.end.allowed = await askClaudeGate(options, turn);
      for (const frame of turn.frames) {
        session = ('session_id' in frame && frame.session_id) || session;
        yield frame;
        if (carries(frame, turn.stopAfter)) ctx.stop();
      }
    }
  };
}

/** A send may claim the warm CLI or spawn one, so every CLI plays from the row's queue. */
function driveClaude(frames: VendorTurns['claude'], ctx: TurnContext): ExecuteOverrides {
  transformerMock.mockImplementation(realTransformer);
  ctx.claudeTurns.push({ frames, stopAfter: ctx.stopAfter, ask: ctx.ask, asksOpen: ctx.asksOpen });
  const query = mockQuery(
    ctx.h.claudeQueryMock,
    claudeCli(ctx, () => query.close.mock.calls.length > 0),
  );
  return {};
}

function driveCodex(notifications: VendorTurns['codex'], ctx: TurnContext): ExecuteOverrides {
  const chunks = notifications.flatMap((args) => mapNotificationToChunks(...args));
  vi.mocked(runCodexAgent).mockImplementationOnce((params) => {
    const reminders = Object.values(params.operatorReminders ?? {}).map((entry) => entry.value);
    const end = stopEnd(params.abortController?.signal);
    const told = [...reminders, params.prompt].join('\n');
    ctx.inputs.push({ resumedFrom: params.resumeThreadId, told, end });
    return stoppable(runnerStream(chunks), ctx, end, params.checkApproval);
  });
  return {};
}

/** The part of the turn every other runner is started with that the grid reads. */
type AgentTurnInput = {
  prompt: string;
  resumeSessionId?: string;
  abortController: AbortController;
  checkApproval: CodexApprovalCheck;
};

function agentTurn(chunks: UIMessageChunk[], ctx: TurnContext) {
  return (turn: AgentTurnInput) => {
    const end = stopEnd(turn.abortController.signal);
    ctx.inputs.push({ resumedFrom: turn.resumeSessionId, told: turn.prompt, end });
    return stoppable(runnerStream(chunks), ctx, end, turn.checkApproval);
  };
}

/** How each runtime's translator output reaches the executor, through the seam it already has. */
type Drivers = {
  [R in AgentRuntime]: (turn: VendorTurns[R], ctx: TurnContext) => ExecuteOverrides;
};

const DRIVERS: Drivers = {
  claude: driveClaude,
  codex: driveCodex,
  acp: (turn, ctx) => ({ startAcpTurn: agentTurn(acpChunks(turn), ctx) }),
  copilot: (events, ctx) => ({ startCopilotTurn: agentTurn(copilotChunks(events), ctx) }),
  cursor: (messages, ctx) => ({ startCursorTurn: agentTurn(cursorChunks(messages), ctx) }),
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

type TurnOptions = TurnScript & { mode?: ChatMode; sessionId?: string };

/** One sub-chat on `runtime` with a spied editor window: run its turns in order, then read them. */
export function startRow<R extends AgentRuntime>(h: GridHarness, runtime: R) {
  const subChatId = randomUUID();
  restoreSuiteMocksAfterTest();
  const send = spyEditorWindow();
  const stop = () => handleRemoteStop({ chatId: h.basePayload.chatId, subChatId });
  const row: Omit<TurnContext, keyof TurnScript> = { h, inputs: [], claudeTurns: [], stop };
  const provider = PROVIDER_FOR[runtime];
  const execute = async (overrides: ExecuteOverrides, payload: TurnOptions = {}) => {
    if (provider) vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(credential(provider));
    const { mode = h.basePayload.mode, sessionId } = payload;
    await h.handleRemoteExecute(
      { ...h.basePayload, mode, sessionId, subChatId, message: 'conformance turn' },
      { ...overrides, runtimeFor: () => runtime },
    );
    // Non-Claude completions are sent on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    subChatId,
    stop,
    execute,
    turn: (vendorTurn: VendorTurns[R], options: TurnOptions = {}) =>
      execute(DRIVERS[runtime](vendorTurn, { ...row, ...options }), options),
    /** The session id the sub-chat row holds now, as the next send reads it back. */
    storedSession(): string | undefined {
      const stored = vi
        .mocked(updateSubChatSession)
        .mock.calls.filter(([, id]) => id === subChatId);
      return stored.at(-1)?.[2] ?? undefined;
    },
    observe(): Observed {
      const sent = vi.mocked(socketClient.sendStreamChunkDirect).mock.calls.map(([p]) => p);
      const completed = vi
        .mocked(socketClient.sendExecuteCompleteDirect)
        .mock.calls.map(([p]) => p);
      const errors = vi.mocked(socketClient.sendErrorDirect).mock.calls.map(([p]) => p);
      const cards = vi.mocked(socketClient.sendPermissionRequest).mock.calls.map(([c]) => c);
      return {
        subChatId,
        // SAFETY: every turn loop in the executor streams UIMessageChunk values only.
        chunks: forSubChat(sent, subChatId).map((payload) => payload.chunk as UIMessageChunk),
        fileChanged: send.mock.calls.flatMap(([channel, payload]) =>
          channel === 'file-changed' ? [payload] : [],
        ),
        completed: forSubChat(completed, subChatId).length > 0,
        savedText: forSubChat(completed, subChatId)
          .flatMap((payload) => payload.finalParts ?? [])
          .map((part) => part.text ?? '')
          .join(''),
        errors: forSubChat(errors, subChatId).map((payload) => payload.error),
        inputs: row.inputs,
        cards: forSubChat(cards, subChatId),
      };
    },
  };
}

/** Runs one turn on `runtime` through handleRemoteExecute, fed by its own translator's output. */
export async function runConformanceTurn<R extends AgentRuntime>(
  h: GridHarness,
  runtime: R,
  turn: VendorTurns[R],
): Promise<Observed> {
  const row = startRow(h, runtime);
  await row.turn(turn);
  return row.observe();
}

/** Claude replies and holds on running background work; a wake then plays `burst` into that reply. */
export async function runClaudeWakeBurst(
  h: GridHarness,
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
