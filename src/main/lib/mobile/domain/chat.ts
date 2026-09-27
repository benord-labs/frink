import { buildAnswerMessage } from '../../../../shared/lib/agent-questions/answered-questions';
import {
  HIDDEN_WAKE_MARKER,
  isHiddenWakeMessage,
  stripHiddenWakeMarker,
} from '../../../../shared/lib/message-markers/hidden-wake-marker';
import { stripMessageMarkers } from '../../../../shared/lib/message-markers/strip-message-markers';
import type {
  MobileChatDetail,
  MobileMessage,
  MobileRequest,
} from '../../../../shared/types/remote/mobile';
import {
  listPendingQuestionProjections,
  resolvePendingToolApproval,
} from '../../claude/ask-user-question-approval';
import { getDatabase } from '../../db';
import { getProjectById } from '../../db/repos/projects';
import { sendMessage, sendPermissionResponse, sendStop } from '../../socket/client';
import { ChatBusyError, DuplicateMessageError } from '../../socket/execution/send-admission';
import { getActiveExecution } from '../../socket/streaming/execution-registry';
import { getLiveStreamSeed } from '../../socket/streaming/live-stream';
import { listPendingPermissionRequests } from '../../socket/streaming/pending-permission';
import {
  MobileApiError,
  mobileCallers,
  record,
  requireChat,
  requireExecutionReady,
  text,
} from './context';
import { mobilePermissions, mobileQuestions } from './questions';

function messageProjection(value: unknown): MobileMessage | null {
  const message = record(value);
  if (typeof message.id !== 'string' || typeof message.role !== 'string') return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const body = parts
    .map((part) => record(part))
    .filter((part) => part.type === 'text')
    .map((part) => text(part.text))
    .join('\n');
  if (message.role === 'user' && isHiddenWakeMessage(body)) return null;
  return {
    id: message.id,
    role: message.role,
    text: stripMessageMarkers(stripHiddenWakeMarker(body)),
  };
}

export function mergeMobileTranscript(
  history: unknown[],
  seed: ReturnType<typeof getLiveStreamSeed>,
): MobileMessage[] {
  const messages = new Map<string, MobileMessage>();
  for (const raw of history) {
    const message = messageProjection(raw);
    if (message) messages.set(message.id, message);
  }
  for (const stream of [...seed.terminals, ...seed.streams]) {
    if (!stream.parts?.length) continue;
    if (stream.status !== 'active' && messages.has(stream.assistantMessageId)) continue;
    const message = messageProjection({
      id: stream.assistantMessageId,
      role: 'assistant',
      parts: stream.parts,
    });
    if (message) messages.set(message.id, message);
  }
  return [...messages.values()];
}

export async function readMobileChat(
  input: Extract<MobileRequest, { type: 'chat' }>,
): Promise<MobileChatDetail> {
  const { chat, subChat } = await requireChat(input.id, input.subChatId);
  const historyInput = {
    subChatId: subChat.id,
    limit: 50,
    beforeMessageId: input.beforeMessageId,
  };
  let history = await mobileCallers.chats.getSubChatMessages(historyInput);
  const seed = getLiveStreamSeed(subChat.id);
  if (
    !input.beforeMessageId &&
    seed.terminals.some(
      (terminal) =>
        terminal.durability === 'committed' &&
        !history.messages.some((message) => record(message).id === terminal.assistantMessageId),
    )
  ) {
    history = await mobileCallers.chats.getSubChatMessages(historyInput);
  }
  const active = Boolean(getActiveExecution(subChat.id)) || seed.streams.length > 0;
  return {
    chat: { id: chat.id, name: chat.name ?? 'Untitled chat', projectId: chat.projectId },
    subChatId: subChat.id,
    subChats: chat.subChats.map((sub) => ({ id: sub.id, name: sub.name ?? 'Chat' })),
    messages: mergeMobileTranscript(
      history.messages,
      input.beforeMessageId ? { streams: [], terminals: [] } : seed,
    ),
    hasMore: history.hasMore,
    active,
    error:
      !active && seed.terminals.at(-1)?.status === 'error'
        ? 'The response failed. Check Frink on your computer for details.'
        : null,
    questions: await mobileQuestions(chat.id, subChat.id, chat.taskId),
    permissions: mobilePermissions().filter(
      (entry) => entry.chatId === chat.id && entry.subChatId === subChat.id,
    ),
  };
}

export async function createMobileChat(input: Extract<MobileRequest, { type: 'createChat' }>) {
  if (!(await getProjectById(getDatabase(), input.projectId)))
    throw new MobileApiError(404, 'Project not found.');
  const chat = await mobileCallers.chats.create({
    projectId: input.projectId,
    name: input.name,
    mode: 'agent',
    useWorktree: true,
  });
  return { chatId: chat.id, subChatId: chat.subChats[0].id };
}

type SendInput = { chatId: string; subChatId: string; requestId: string; text: string };
export async function sendMobileMessage(
  input: SendInput,
  extra?: {
    expectedFlowTaskId?: string;
    metadata?: { answeredQuestions: Array<{ label: string; answer: string }> };
  },
) {
  const message = input.text.replaceAll(HIDDEN_WAKE_MARKER, '').trim();
  if (!message) throw new MobileApiError(400, 'Write a message before sending.');
  const { chat } = await requireChat(input.chatId, input.subChatId);
  const payload: Parameters<typeof sendMessage>[0] = {
    chatId: chat.id,
    subChatId: input.subChatId,
    projectId: chat.projectId ?? '',
    userMessage: {
      id: input.requestId,
      role: 'user',
      parts: [{ type: 'text', text: message }],
      metadata: extra?.metadata,
    },
    expectedFlowTaskId: extra?.expectedFlowTaskId,
  };
  try {
    await sendMessage(payload, {
      rejectIfBusy: true,
      // Reason: Validate execution readiness and Flow ownership inside one send admission.
      // fallow-ignore-next-line complexity
      beforeSend: async () => {
        const { task, run } = await mobileCallers.tasks.getDrivingTaskForSubChat({
          subChatId: input.subChatId,
          fallbackTaskId: chat.taskId,
        });
        requireExecutionReady();
        if (
          (extra?.expectedFlowTaskId &&
            (task?.id !== extra.expectedFlowTaskId || task.status !== 'needs_attention')) ||
          (run && (!task || task.status !== 'needs_attention'))
        ) {
          throw new MobileApiError(
            409,
            'This Flow is running or has changed. Open its current step to continue.',
          );
        }
        if (task?.flowRunId) payload.expectedFlowTaskId = task.id;
      },
    });
  } catch (error) {
    if (error instanceof ChatBusyError || error instanceof DuplicateMessageError)
      throw new MobileApiError(409, error.message);
    if (record(error).category === 'FLOW_RUN_ENDED')
      throw new MobileApiError(409, 'This Flow step changed. Refresh the chat before replying.');
    throw error;
  }
  return { ok: true as const };
}

export async function answerMobileQuestion(
  input: Extract<MobileRequest, { type: 'answerQuestion' }>,
) {
  const { chat } = await requireChat(input.chatId, input.subChatId);
  if (input.source === 'live') {
    const held = listPendingQuestionProjections(input.subChatId).find(
      (entry) => entry.chatId === input.chatId && entry.toolUseId === input.id,
    );
    if (!held) throw new MobileApiError(409, 'This question has already closed.');
    validateAnswers(held.questions, input.answers);
    requireExecutionReady();
    if (
      !resolvePendingToolApproval(input.id, {
        approved: true,
        updatedInput: { questions: held.questions, answers: input.answers },
      })
    ) {
      throw new MobileApiError(409, 'This question has already closed.');
    }
  } else {
    const questions = await mobileQuestions(chat.id, input.subChatId, chat.taskId);
    const pending = questions.find((entry) => entry.source === 'parked' && entry.id === input.id);
    if (!pending) throw new MobileApiError(409, 'This task changed. Refresh before answering.');
    validateAnswers(pending.questions, input.answers);
    const answer = pending.questions.length
      ? buildAnswerMessage(pending.questions, input.answers)
      : { text: Object.values(input.answers).join('\n\n') };
    if (!answer) throw new MobileApiError(400, 'Choose or write an answer.');
    await sendMobileMessage(
      { ...input, text: answer.text },
      {
        expectedFlowTaskId: pending.id,
        ...('metadata' in answer ? { metadata: answer.metadata } : {}),
      },
    );
  }
  return { ok: true as const };
}

function validateAnswers(
  questions: Array<{ question: string }>,
  answers: Record<string, string>,
): void {
  if (
    !Object.keys(answers).length ||
    (questions.length > 0 &&
      (Object.keys(answers).some(
        (key) => !questions.some((question) => question.question === key),
      ) ||
        questions.some((question) => !answers[question.question]?.trim())))
  )
    throw new MobileApiError(400, 'Answer each question before sending.');
}

export async function respondMobilePermission(
  input: Extract<MobileRequest, { type: 'respondPermission' }>,
) {
  await requireChat(input.chatId, input.subChatId);
  const pending = listPendingPermissionRequests().find(
    (entry) =>
      entry.requestId === input.requestId &&
      entry.chatId === input.chatId &&
      entry.subChatId === input.subChatId,
  );
  if (!pending) throw new MobileApiError(409, 'This permission request has already closed.');
  if (!mobilePermissions().find((entry) => entry.requestId === pending.requestId)?.supported) {
    throw new MobileApiError(409, 'Review this request on your computer.');
  }
  if (input.approved) requireExecutionReady();
  sendPermissionResponse({
    chatId: pending.chatId,
    subChatId: pending.subChatId,
    requestId: pending.requestId,
    approved: input.approved,
  });
  return { ok: true as const };
}

function executionIdentity(subChatId: string): string {
  return [
    getActiveExecution(subChatId)?.streamEpoch,
    ...getLiveStreamSeed(subChatId).streams.map((stream) => stream.streamEpoch),
  ]
    .filter(Boolean)
    .join('|');
}

export async function stopMobileChat(input: Extract<MobileRequest, { type: 'stopChat' }>) {
  const { chat } = await requireChat(input.chatId, input.subChatId);
  const execution = executionIdentity(input.subChatId);
  const { run } = await mobileCallers.tasks.getDrivingTaskForSubChat({
    subChatId: input.subChatId,
    fallbackTaskId: chat.taskId,
  });
  if (!execution || execution !== executionIdentity(input.subChatId))
    throw new MobileApiError(409, 'This response changed. Refresh before stopping it.');
  if (run) await mobileCallers.flows.cancelRun({ runId: run.id });
  else sendStop({ chatId: input.chatId, subChatId: input.subChatId });
  return { ok: true as const };
}
