import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SecretGitState, SecretRequest } from '../../../../shared/types/task-signal';
import { getDatabase } from '../../db';
import { getChatById } from '../../db/repos/chats';
import { getTaskById } from '../../db/repos/tasks';
import { sendMessage } from '../../socket/client';
import {
  SecretRequestError,
  serializeForFile,
  upsertEnvLine,
  writeEnvFileAtomic,
} from './env-file';
import { excludeFromGit } from './git-state';
import {
  clearLiveSecretRequest,
  findSecretRequest,
  projectPathOfChat,
  savedText,
} from './store';
import { resolveMainCheckoutTarget, resolveSecretTarget } from './targets';

/** The user's answer: `value` to save it, null for "Don't save". */
export type SecretAnswer = {
  subChatId: string;
  requestId: string;
  /** The parked task carrying the request; null for a chat with no task. */
  taskId: string | null;
  value: string | null;
};

async function readEnvFile(target: string): Promise<string> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

type FileTarget = { target: string; git: SecretGitState };

/** The main checkout file the form named, checked again; null when the form named none. */
async function mainTargetToSave(request: SecretRequest): Promise<FileTarget | null> {
  const shown = request.mainCheckout;
  if (!shown || !('path' in shown)) return null;
  const projectPath = await projectPathOfChat(request.chatId);
  const now = await resolveMainCheckoutTarget(request.cwd, projectPath, request.file, request.name);
  if (!now || !('path' in now) || now.path !== shown.path) {
    throw new SecretRequestError(
      `${shown.path} changed since this form opened. Choose Don't save and ask the agent again.`,
    );
  }
  return { target: now.path, git: now.git };
}

/** Writes every file or none: both edits are verified before either file changes. */
async function saveSecret(request: SecretRequest, value: string): Promise<void> {
  const own = await resolveSecretTarget(request.cwd, request.file, request.name);
  const main = await mainTargetToSave(request);
  const targets: FileTarget[] = main ? [own, main] : [own];
  const save = async () => {
    const edits = await Promise.all(
      targets.map(async (file) => {
        const content = await readEnvFile(file.target);
        return { ...file, content: upsertEnvLine(content, request.name, value.trim()) };
      }),
    );
    // Before the writes: a failure after them would leave a saved key reported as unsaved.
    for (const edit of edits) {
      if (edit.git === 'untracked') await excludeFromGit(path.dirname(edit.target), edit.target);
    }
    for (const edit of edits) await writeEnvFileAtomic(edit.target, edit.content);
  };
  // One lock order, the chat's own file then the main one, so two saves cannot deadlock.
  await serializeForFile(own.target, () => (main ? serializeForFile(main.target, save) : save()));
}

/** The executor's stale-step check, run before the write: a reply it would decline must not save
 * the value first. */
async function assertFlowStepCurrent(
  chatId: string,
  subChatId: string,
  taskId: string,
  chatRowTaskId: string | null | undefined,
): Promise<void> {
  const { resolveFlowContinuationExecutionTask } = await import('../../task-executor');
  const { resolveFlowSignalArming } = await import('../../socket/flow-signal');
  const { taskIdForExecution } = resolveFlowContinuationExecutionTask({
    chatId,
    chatRowTaskId: chatRowTaskId ?? null,
    expectedFlowTaskId: taskId,
  });
  const armed = await resolveFlowSignalArming(subChatId, taskIdForExecution);
  if (armed.effectiveSignalTaskId !== taskId) {
    throw new SecretRequestError('This Flow step changed. Refresh before replying.');
  }
}

export function openSecretRequest(answer: SecretAnswer): Promise<SecretRequest | null> {
  return findSecretRequest(answer.subChatId, answer.requestId, answer.taskId);
}

/** Answers in ONE send: inside the chat's send admission the request is re-checked and the value
 * written before the message goes, so a failure leaves nothing written and the request open. */
export async function answerSecretRequest(
  request: SecretRequest,
  answer: SecretAnswer,
): Promise<void> {
  const chat = await getChatById(getDatabase(), request.chatId);
  const text =
    answer.value === null
      ? `I chose not to save ${request.name}.`
      : savedText(request);
  const payload: Parameters<typeof sendMessage>[0] = {
    chatId: request.chatId,
    subChatId: answer.subChatId,
    projectId: chat?.projectId ?? '',
    userMessage: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] },
  };
  await sendMessage(payload, {
    rejectIfBusy: true,
    beforeSend: async () => {
      const current = await openSecretRequest(answer);
      if (!current) throw new SecretRequestError('This request has closed.');
      const task = answer.taskId ? await getTaskById(getDatabase(), answer.taskId) : null;
      if (task?.flowRunId) {
        payload.expectedFlowTaskId = task.id;
        await assertFlowStepCurrent(request.chatId, answer.subChatId, task.id, chat?.taskId);
      }
      if (answer.value !== null) await saveSecret(current, answer.value);
    },
  });
  clearLiveSecretRequest(answer.subChatId, request.id);
}
