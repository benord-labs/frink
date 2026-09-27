import type { MobilePermission, MobileQuestion } from '../../../../shared/types/remote/mobile';
import { agentUserQuestionsSchema } from '../../trpc/routers/frink-task-signal';
import { listPendingQuestionProjections } from '../../claude/ask-user-question-approval';
import {
  listPendingMoveChatRequests,
  listPendingPermissionRequests,
} from '../../socket/streaming/pending-permission';
import { mobileCallers, record, text } from './context';

export function mobilePermissions(): MobilePermission[] {
  return [
    ...listPendingPermissionRequests().map((permission) => {
      const operation = permission.prompt
        ? JSON.stringify(permission.prompt.input, null, 2)
        : permission.path;
      const description = [permission.reason, operation].filter(Boolean).join('\n\n');
      const fits = description.length <= 12000;
      return {
        requestId: permission.requestId,
        chatId: permission.chatId,
        subChatId: permission.subChatId,
        title: permission.toolName ?? 'Permission requested',
        description: fits
          ? description
          : 'This request is too large to review on mobile. Open Frink on your computer.',
        // Rich registration and persistent Flow grants are reviewed on desktop in this MVP.
        supported: fits && !permission.prompt?.presentation && permission.type !== 'flow_consent',
      };
    }),
    ...listPendingMoveChatRequests().map((permission) => ({
      requestId: permission.requestId,
      chatId: permission.chatId,
      subChatId: permission.subChatId,
      title: 'Move chat',
      description: `Move to ${permission.projectName}. Review this on your computer.`,
      supported: false,
    })),
  ];
}

export function parkedQuestion(
  task: { id: string; status: string; result?: unknown },
  chatId: string,
  subChatId: string,
): MobileQuestion | null {
  if (task.status !== 'needs_attention') return null;
  const signal = record(record(task.result).agentSignal);
  if (!['awaiting_input', 'blocked', 'partial'].includes(text(signal.state))) return null;
  const parsed = agentUserQuestionsSchema.safeParse(signal.questions);
  return {
    id: task.id,
    source: 'parked',
    chatId,
    subChatId,
    title: text(signal.summary, 'The agent needs your input.'),
    questions: parsed.success ? parsed.data : [],
  };
}

export async function mobileQuestions(
  chatId: string,
  subChatId: string,
  fallbackTaskId: string | null,
) {
  const live = listPendingQuestionProjections(subChatId)
    .filter((q) => q.chatId === chatId)
    .map((q): MobileQuestion => ({
      chatId: q.chatId,
      subChatId: q.subChatId,
      questions: q.questions,
      id: q.toolUseId,
      source: 'live',
      title: q.questions[0]?.header ?? 'Question',
    }));
  if (live.length) return live;
  const { task } = await mobileCallers.tasks.getDrivingTaskForSubChat({
    subChatId,
    fallbackTaskId,
  });
  const parked = task && parkedQuestion(task, chatId, subChatId);
  return parked ? [parked] : [];
}
