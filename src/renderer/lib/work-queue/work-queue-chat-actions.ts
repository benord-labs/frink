import { approvedPlanContextSchema } from '../../../shared/types/approved-plan-context-schema';
import {
  type ApprovedPlanContext,
  findUnapprovedPlanPart,
  isPlanReadyPart,
  type MessagePartLike,
} from '../../../shared/types/plan';

type ResolvedWorkQueueSubChat = {
  id?: string;
  messages?: unknown;
  streamId?: string | null;
};

type WorkQueuePlanApproval = {
  context: ApprovedPlanContext;
  flowDriven: boolean;
};

type ChatLookupResult =
  | { status: 'found'; chat: unknown }
  | { status: 'missing' }
  | { status: 'unknown_error' };

type ChatActions = {
  ownsNavigation: () => boolean;
  getChat: (chatId: string) => Promise<unknown>;
  getSubChat: (id: string) => Promise<ResolvedWorkQueueSubChat | null>;
  seedUserMessageIfEmpty: (input: {
    id: string;
    message: { id: string; role: 'user'; parts: [{ type: 'text'; text: string }] };
  }) => Promise<unknown>;
  navigate: (chatId: string, subChatId?: string) => boolean;
  isNotFoundError: (error: unknown) => boolean;
  onMissingChat: () => void;
  onUnknownChat: () => void;
};

type OpenChatInput = {
  taskId: string;
  prompt: string;
  chatId: string;
  resultSubChatId?: string;
  skipExistenceCheck?: boolean;
  preloadedChat?: unknown;
};

type StartExecutionInput = {
  taskId: string;
  chatId: string;
  resultSubChatId?: string;
  startExecution: () => Promise<unknown>;
  setPendingPlan: (subChatId: string) => void;
  recoverPlan: (input: {
    approval: WorkQueuePlanApproval;
    chat: unknown;
    subChat: ResolvedWorkQueueSubChat;
    subChatId: string;
  }) => void;
  onInvalidPlan: (description: string) => void;
};

export function parseWorkQueueMessages(rawMessages: unknown): unknown[] | null {
  if (Array.isArray(rawMessages)) return rawMessages;
  if (typeof rawMessages !== 'string') return null;
  try {
    const parsed = JSON.parse(rawMessages) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getAssistantMessageParts(message: unknown): unknown[] | null {
  if (!message || typeof message !== 'object') return null;
  if (!('role' in message) || message.role !== 'assistant') return null;
  if (!('parts' in message) || !Array.isArray(message.parts)) return null;
  return message.parts;
}

function isMessagePartLike(part: unknown): part is MessagePartLike {
  return (
    part !== null && typeof part === 'object' && 'type' in part && typeof part.type === 'string'
  );
}

function isPlanReadyMessagePart(part: unknown): part is MessagePartLike {
  return isMessagePartLike(part) && isPlanReadyPart(part);
}

function getPlanApproval(parts: unknown[]): WorkQueuePlanApproval | null {
  const part = parts.find(isPlanReadyMessagePart);
  if (!part) return null;
  try {
    const found = findUnapprovedPlanPart([part]);
    const parsedContext = approvedPlanContextSchema.safeParse(found?.planContext);
    return parsedContext.success
      ? { context: parsedContext.data, flowDriven: part.input?.flowDriven === true }
      : null;
  } catch {
    return null;
  }
}

function findWorkQueuePlanApproval(rawMessages: unknown): WorkQueuePlanApproval | null {
  const messages = parseWorkQueueMessages(rawMessages);
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parts = getAssistantMessageParts(messages[index]);
    if (!parts) continue;
    // The newest plan-ready part decides: an unusable one must not fall back to an older plan.
    if (parts.some(isPlanReadyMessagePart)) return getPlanApproval(parts);
  }
  return null;
}

async function seedTaskPromptIfEmpty(
  input: OpenChatInput,
  subChatId: string | undefined,
  fetchedSubChat: ResolvedWorkQueueSubChat | null | undefined,
  actions: ChatActions,
): Promise<boolean> {
  if (!subChatId) return true;
  try {
    const subChat =
      fetchedSubChat?.id === subChatId ? fetchedSubChat : await actions.getSubChat(subChatId);
    if (!actions.ownsNavigation()) return false;
    if (parseWorkQueueMessages(subChat?.messages)?.length !== 0) return true;
    await actions.seedUserMessageIfEmpty({
      id: subChatId,
      message: {
        id: `msg-task-${input.taskId}`,
        role: 'user',
        parts: [{ type: 'text', text: input.prompt }],
      },
    });
    return actions.ownsNavigation();
  } catch {
    // A failed sub-chat recovery must not block opening a verified parent chat.
    return true;
  }
}

async function lookupChat(chatId: string, actions: ChatActions): Promise<ChatLookupResult> {
  try {
    const chat = await actions.getChat(chatId);
    return chat ? { status: 'found', chat } : { status: 'missing' };
  } catch (error) {
    return actions.isNotFoundError(error) ? { status: 'missing' } : { status: 'unknown_error' };
  }
}

async function resolveSubChat(
  chatId: string,
  resultSubChatId: string | undefined,
  existingChat: unknown,
  actions: ChatActions,
): Promise<{ subChatId?: string; fetchedSubChat?: ResolvedWorkQueueSubChat | null }> {
  let subChatId = resultSubChatId;
  let fetchedSubChat: ResolvedWorkQueueSubChat | null | undefined;
  if (!subChatId) {
    try {
      fetchedSubChat = await actions.getSubChat(chatId);
      subChatId = fetchedSubChat?.id;
    } catch {
      // Fall through to the parent's sub-chat list.
    }
    if (!subChatId) {
      try {
        const chat = existingChat ?? (await actions.getChat(chatId));
        subChatId = (chat as { subChats?: Array<{ id: string }> })?.subChats?.[0]?.id;
        fetchedSubChat = undefined;
      } catch {
        // Opening the parent chat remains useful when its sub-chat cannot be resolved.
      }
    }
  }
  return { subChatId, ...(fetchedSubChat ? { fetchedSubChat } : {}) };
}

export async function openWorkQueueTaskChat(
  input: OpenChatInput,
  actions: ChatActions,
): Promise<string | undefined> {
  let preloadedChat = input.preloadedChat;
  if (!input.skipExistenceCheck) {
    const lookup = await lookupChat(input.chatId, actions);
    if (!actions.ownsNavigation()) return undefined;
    if (lookup.status === 'missing') {
      actions.onMissingChat();
      return undefined;
    }
    if (lookup.status === 'unknown_error') {
      actions.onUnknownChat();
      return undefined;
    }
    preloadedChat = lookup.chat;
  }
  const { subChatId, fetchedSubChat } = await resolveSubChat(
    input.chatId,
    input.resultSubChatId,
    preloadedChat,
    actions,
  );
  if (!actions.ownsNavigation()) return undefined;
  if (!(await seedTaskPromptIfEmpty(input, subChatId, fetchedSubChat, actions))) return undefined;
  return actions.navigate(input.chatId, subChatId) ? subChatId : undefined;
}

export async function startWorkQueuePlanExecution(
  input: StartExecutionInput,
  actions: ChatActions,
): Promise<void> {
  const lookup = await lookupChat(input.chatId, actions);
  if (!actions.ownsNavigation()) return;
  if (lookup.status === 'missing') return actions.onMissingChat();
  if (lookup.status === 'unknown_error') return actions.onUnknownChat();
  const { subChatId, fetchedSubChat } = await resolveSubChat(
    input.chatId,
    input.resultSubChatId,
    lookup.chat,
    actions,
  );
  const verifiedSubChat =
    subChatId && fetchedSubChat?.id === subChatId
      ? fetchedSubChat
      : subChatId
        ? await actions.getSubChat(subChatId).catch(() => null)
        : null;
  if (!actions.ownsNavigation()) return;
  if (!subChatId || verifiedSubChat?.id !== subChatId) {
    input.onInvalidPlan('Linked sub-chat could not be resolved for execution.');
    return;
  }
  const approval = findWorkQueuePlanApproval(verifiedSubChat.messages);
  if (!approval || approval.flowDriven) {
    input.onInvalidPlan('Linked sub-chat has no eligible reviewed plan to execute.');
    return;
  }
  try {
    await input.startExecution();
  } catch {
    return;
  }
  if (actions.navigate(input.chatId, subChatId)) input.setPendingPlan(subChatId);
  else input.recoverPlan({ approval, chat: lookup.chat, subChat: verifiedSubChat, subChatId });
}
