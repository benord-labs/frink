import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { SecretRequest } from '../../../../shared/types/task-signal';
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
import { clearLiveSecretRequest, findSecretRequest } from './store';
import { resolveSecretTarget } from './targets';

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

async function saveSecret(request: SecretRequest, value: string): Promise<void> {
  const { target, git } = await resolveSecretTarget(request.cwd, request.file, request.name);
  await serializeForFile(target, async () => {
    const content = upsertEnvLine(await readEnvFile(target), request.name, value.trim());
    // Before the write: a failure after it would leave a saved key reported as unsaved.
    if (git === 'untracked') await excludeFromGit(request.cwd, target);
    await writeEnvFileAtomic(target, content);
  });
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
      : `${request.name} saved to ${request.file}`;
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
      if (task?.flowRunId) payload.expectedFlowTaskId = task.id;
      if (answer.value !== null) await saveSecret(current, answer.value);
    },
  });
  clearLiveSecretRequest(answer.subChatId, request.id);
}
