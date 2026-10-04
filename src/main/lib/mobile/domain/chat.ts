import { buildAnswerMessage } from '../../../../shared/lib/agent-questions/answered-questions';
import {
  HIDDEN_WAKE_MARKER,
  isHiddenWakeMessage,
  stripHiddenWakeMarker,
} from '../../../../shared/lib/message-markers/hidden-wake-marker';
import { stripMessageMarkers } from '../../../../shared/lib/message-markers/strip-message-markers';
import {
  extractCanonicalPlanTextForFilter,
  filterCanonicalPlanParts,
  type CanonicalPlanPartLike,
} from '../../../../shared/plan-parts-filter';
import { SUBAGENT_TEXT_PART_TYPE } from '../../../../shared/subagent-parts';
import {
  type ApprovedPlanContext,
  findApprovablePlan,
  isFrinkPlanMessagePartType,
  type PlanMessageLike,
  stripPlanFrontmatter,
} from '../../../../shared/types/plan';
import type {
  MobileActivity,
  MobileChatDetail,
  MobileMessage,
  MobileMessagePart,
  MobileRequest,
} from '../../../../shared/types/remote/mobile';
import {
  listPendingQuestionProjections,
  resolvePendingToolApproval,
} from '../../claude/ask-user-question-approval';
import { getDatabase } from '../../db';
import { getProjectById } from '../../db/repos/projects';
import { readWakeHolds } from '../../socket/claude-wake-hold';
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
import { resolveMobileAttachments } from './attachments';

type StreamStatus = 'active' | 'held' | 'settling' | 'settled' | 'error';
type ToolState = Extract<MobileMessagePart, { type: 'tool' }>['state'];

// An unfinished tool call takes its state from the stream that owns it; any other stream state
// leaves the outcome genuinely unknown.
const unfinishedToolStates: Partial<Record<StreamStatus, ToolState>> = {
  active: 'running',
  settled: 'interrupted',
  error: 'interrupted',
};

function toolState(part: Record<string, unknown>, streamStatus?: StreamStatus): ToolState {
  if (part.state === 'output-error') return 'failed';
  if (part.state === 'output-available')
    return record(part.output).success === false ? 'failed' : 'completed';
  if (part.state !== 'input-available' && part.state !== 'input-streaming') return 'unknown';
  return (streamStatus && unfinishedToolStates[streamStatus]) || 'unknown';
}

// `@[pasted:<size>:<name>|<path>]` — a desktop large paste or a phone file attachment.
const PASTED_MENTION = /@\[pasted:\d+:([^|\]]*)\|[^\]]*\]\s?/g;

/** Pulls pasted-file mentions out of text so the phone shows them as attachments, not tokens. */
export function splitPastedMentions(body: string): { text: string; names: string[] } {
  const names: string[] = [];
  const text = body.replace(PASTED_MENTION, (_match, name: string) => {
    names.push(name || 'Attachment');
    return '';
  });
  return { text: text.trim(), names };
}

function isImagePart(part: Record<string, unknown>): boolean {
  if (part.type === 'data-image') return true;
  return (
    part.type === 'file' && typeof part.mimeType === 'string' && part.mimeType.startsWith('image/')
  );
}

/** Text as the phone shows it: pasted-file mentions become attachment chips. */
function textParts(body: string): MobileMessagePart[] {
  const { text: remaining, names } = splitPastedMentions(body);
  const chips = names.map((name) => ({ type: 'attachment', kind: 'file', name }) as const);
  return remaining ? [...chips, { type: 'text', text: remaining }] : chips;
}

function toolPart(
  part: Record<string, unknown>,
  id: string,
  streamStatus?: StreamStatus,
): MobileMessagePart[] {
  const name = text(part.toolName, String(part.type).slice(5)).trim();
  if (!name) return [];
  return [
    {
      type: 'tool',
      id: text(part.toolCallId).trim() || id,
      name,
      state: toolState(part, streamStatus),
    },
  ];
}

function messagePartProjection(
  value: unknown,
  id: string,
  streamStatus?: StreamStatus,
): MobileMessagePart[] {
  const part = record(value);
  if (isImagePart(part)) return [{ type: 'attachment', kind: 'image', name: 'Image' }];
  if (part.type === 'text') return textParts(text(part.text));
  if (part.type === SUBAGENT_TEXT_PART_TYPE) return textParts(text(record(part.input).text));
  if (typeof part.type !== 'string') return [];
  if (isFrinkPlanMessagePartType(part.type)) {
    const plan = record(part.input);
    const body = stripPlanFrontmatter(text(plan.planText));
    return body ? [{ type: 'plan', id: text(plan.planId) || id, text: body }] : [];
  }
  if (!part.type.startsWith('tool-')) return [];
  // Keyed on the tool name, not state: the marker's state reads 'unknown' once its stream expires.
  if (part.toolName === 'Steer') {
    const steered = text(record(part.input).text).trim();
    return steered ? [{ type: 'steer', text: steered }] : [];
  }
  return toolPart(part, id, streamStatus);
}

function messageProjection(value: unknown, streamStatus?: StreamStatus): MobileMessage | null {
  const message = record(value);
  if (typeof message.id !== 'string' || typeof message.role !== 'string') return null;
  const raw = (Array.isArray(message.parts) ? message.parts : []).map(
    record,
  ) as CanonicalPlanPartLike[];
  // As desktop shows it: plan markdown the agent also wrote as prose appears once, in the plan.
  const rawParts = filterCanonicalPlanParts(raw, extractCanonicalPlanTextForFilter(raw));
  const status = record(message.metadata).interruptedBy ? 'settled' : streamStatus;
  const parts: MobileMessagePart[] = [];
  rawParts.forEach((part, index) => {
    for (const projected of messagePartProjection(part, `${message.id}:${index}`, status)) {
      const previous = parts.at(-1);
      if (projected.type === 'text' && previous?.type === 'text') {
        previous.text += `\n${projected.text}`;
      } else parts.push(projected);
    }
  });
  const body = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  if (message.role === 'user' && isHiddenWakeMessage(body)) return null;
  return {
    id: message.id,
    role: message.role,
    text: stripMessageMarkers(stripHiddenWakeMarker(body)),
    parts: parts.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: stripMessageMarkers(stripHiddenWakeMarker(part.text)) }
        : part,
    ),
  };
}

export function mergeMobileTranscript(
  history: unknown[],
  seed: ReturnType<typeof getLiveStreamSeed>,
): MobileMessage[] {
  const messages = new Map<string, MobileMessage>();
  const statuses = new Map(
    [...seed.terminals, ...seed.streams].map((stream) => [
      stream.assistantMessageId,
      stream.status,
    ]),
  );
  for (const raw of history) {
    const message = messageProjection(raw, statuses.get(text(record(raw).id)));
    if (message) messages.set(message.id, message);
  }
  for (const stream of [...seed.terminals, ...seed.streams]) {
    if (!stream.parts?.length) continue;
    if (stream.status !== 'active' && messages.has(stream.assistantMessageId)) continue;
    const message = messageProjection(
      { id: stream.assistantMessageId, role: 'assistant', parts: stream.parts },
      stream.status,
    );
    if (message) messages.set(message.id, message);
  }
  return [...messages.values()];
}

/** A held stream is parked on background work; anything else live is a running response. */
export function subChatActivity(subChatId: string): MobileActivity {
  const streams = getLiveStreamSeed(subChatId).streams;
  if (getActiveExecution(subChatId) || streams.some((stream) => stream.status !== 'held'))
    return 'running';
  return streams.length ? 'background' : 'idle';
}

/** Not finished yet: responding, waiting on background work, or a wait that is over while its
 * CLI is still writing (the hold stays registered until its pump ends). */
export function subChatBusy(subChatId: string): boolean {
  const hold = readWakeHolds().get(subChatId);
  return subChatActivity(subChatId) !== 'idle' || (!!hold && !hold.pump.isEnded());
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
  const activity = subChatActivity(subChat.id);
  const plan = findApprovablePlan(history.messages as PlanMessageLike[], subChat.mode === 'plan');
  const { task, run } = await mobileCallers.tasks.getDrivingTaskForSubChat({
    subChatId: subChat.id,
    fallbackTaskId: chat.taskId,
  });
  return {
    chat: { id: chat.id, name: chat.name ?? 'Untitled chat', projectId: chat.projectId },
    subChatId: subChat.id,
    subChats: chat.subChats.map((sub) => ({
      id: sub.id,
      name: sub.name ?? 'Chat',
      activity: sub.id === subChat.id ? activity : subChatActivity(sub.id),
    })),
    messages: mergeMobileTranscript(
      history.messages,
      input.beforeMessageId ? { streams: [], terminals: [] } : seed,
    ),
    hasMore: history.hasMore,
    activity,
    // A live run owns the conversation even before its own task exists, as the send check treats it.
    kind: run || task?.flowRunId ? 'flow' : 'chat',
    error:
      activity === 'idle' && seed.terminals.at(-1)?.status === 'error'
        ? 'The response failed. Open Frink on your Mac to see why.'
        : null,
    questions: await mobileQuestions(chat.id, subChat.id, chat.taskId),
    permissions: mobilePermissions().filter(
      (entry) => entry.chatId === chat.id && entry.subChatId === subChat.id,
    ),
    pendingPlanId: (activity === 'idle' && !input.beforeMessageId && plan?.planId) || null,
  };
}

export async function createMobileChat(input: Extract<MobileRequest, { type: 'createChat' }>) {
  if (!(await getProjectById(getDatabase(), input.projectId)))
    throw new MobileApiError(404, 'Project not found.');
  const chat = await mobileCallers.chats.create({
    projectId: input.projectId,
    name: input.name,
    mode: input.mode ?? 'agent',
    useWorktree: input.useWorktree ?? true,
  });
  return { chatId: chat.id, subChatId: chat.subChats[0].id };
}

/** Permanently deletes an ordinary chat, as desktop's "Delete chat permanently" does. A chat that
 *  belongs to a task or a running Flow is left to desktop, which asks what to do with that work. */
export async function deleteMobileChat(input: Extract<MobileRequest, { type: 'deleteChat' }>) {
  const { chat } = await requireChat(input.chatId);
  const drivers = await Promise.all(
    chat.subChats.map((subChat) =>
      mobileCallers.tasks.getDrivingTaskForSubChat({ subChatId: subChat.id, fallbackTaskId: null }),
    ),
  );
  if (chat.taskId || drivers.some(({ run }) => run))
    throw new MobileApiError(
      409,
      'This chat belongs to a task or Flow. Delete it from Frink on your computer.',
    );
  await mobileCallers.chats.delete({ id: chat.id });
  return { ok: true as const };
}

type SendInput = {
  chatId: string;
  subChatId: string;
  requestId: string;
  text: string;
  attachments?: string[];
};
export async function sendMobileMessage(
  input: SendInput,
  extra?: {
    expectedFlowTaskId?: string;
    metadata?: { answeredQuestions: Array<{ label: string; answer: string }> };
    /** A plan approval: the mode it switches to and the plan the turn implements. */
    mode?: 'agent';
    approvedPlanContext?: ApprovedPlanContext;
  },
) {
  const message = input.text.replaceAll(HIDDEN_WAKE_MARKER, '').trim();
  if (!message && !input.attachments?.length) {
    throw new MobileApiError(400, 'Write a message before sending.');
  }
  const { chat } = await requireChat(input.chatId, input.subChatId);
  const attachments = input.attachments?.length
    ? await resolveMobileAttachments(input.attachments, {
        chatId: chat.id,
        subChatId: input.subChatId,
      })
    : null;
  // Same layout as a desktop send: file mentions lead the text part, images follow it.
  const mentions = attachments?.fileMentions.join(' ') ?? '';
  const payload: Parameters<typeof sendMessage>[0] = {
    chatId: chat.id,
    subChatId: input.subChatId,
    projectId: chat.projectId ?? '',
    userMessage: {
      id: input.requestId,
      role: 'user',
      parts: [
        { type: 'text', text: mentions ? `${mentions} ${message}` : message },
        ...(attachments?.imageParts ?? []),
      ],
      metadata: extra?.metadata,
    },
    expectedFlowTaskId: extra?.expectedFlowTaskId,
    mode: extra?.mode,
    approvedPlanContext: extra?.approvedPlanContext,
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
        // Approving starts a reviewed task, only once the turn is sure to run.
        if (extra?.approvedPlanContext && task?.status === 'plan_ready')
          await mobileCallers.tasks.startExecution({ taskId: task.id });
      },
    });
  } catch (error) {
    if (error instanceof ChatBusyError || error instanceof DuplicateMessageError)
      throw new MobileApiError(409, error.message);
    if (record(error).category === 'FLOW_RUN_ENDED')
      throw new MobileApiError(409, 'This Flow step changed. Refresh the chat before replying.');
    throw error;
  }
  await attachments?.release();
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
