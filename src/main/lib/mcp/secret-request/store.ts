import { z } from 'zod';
import type { SecretRequest } from '../../../../shared/types/task-signal';
import { getDatabase } from '../../db';
import { getChatById } from '../../db/repos/chats';
import { getProjectById } from '../../db/repos/projects';
import { getTaskById } from '../../db/repos/tasks';

const gitStateSchema = z.enum(['ignored', 'untracked', 'tracked', 'none']);

const secretRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  chatId: z.string(),
  file: z.string(),
  cwd: z.string(),
  reason: z.string(),
  replaces: z.boolean(),
  git: gitStateSchema,
  mainCheckout: z
    .union([
      z.object({ path: z.string(), replaces: z.boolean(), git: gitStateSchema }),
      z.object({ skipped: z.string() }),
    ])
    .optional(),
});

/** The fixed text the agent receives once the value is saved, naming every file written. */
export function savedText(request: SecretRequest): string {
  const main = request.mainCheckout;
  const also = main && 'path' in main ? ` and to ${main.path}` : '';
  return `${request.name} saved to ${request.file}${also}`;
}

/** The chat's project folder: the main checkout a worktree chat's secret is also saved to. */
export async function projectPathOfChat(chatId: string): Promise<string | null> {
  const chat = await getChatById(getDatabase(), chatId);
  if (!chat?.projectId) return null;
  return (await getProjectById(getDatabase(), chat.projectId))?.path ?? null;
}

/** Requests from chats with no task to park. They live until answered or the app quits. */
const liveRequests = new Map<string, SecretRequest>();

export function getLiveSecretRequest(subChatId: string): SecretRequest | null {
  return liveRequests.get(subChatId) ?? null;
}

export function setLiveSecretRequest(subChatId: string, request: SecretRequest): void {
  liveRequests.set(subChatId, request);
}

export function clearLiveSecretRequest(subChatId: string, requestId: string): void {
  if (liveRequests.get(subChatId)?.id === requestId) liveRequests.delete(subChatId);
}

/** The open request `requestId`: the chat's live one, else the one parking `taskId`. */
export async function findSecretRequest(
  subChatId: string,
  requestId: string,
  taskId: string | null,
): Promise<SecretRequest | null> {
  const live = getLiveSecretRequest(subChatId);
  if (live?.id === requestId) return live;
  if (!taskId) return null;
  const task = await getTaskById(getDatabase(), taskId);
  if (task?.status !== 'needs_attention') return null;
  const signal = z
    .object({ agentSignal: z.object({ secretRequest: secretRequestSchema }) })
    .safeParse(task.result);
  const parked = signal.success ? signal.data.agentSignal.secretRequest : null;
  return parked?.id === requestId ? parked : null;
}
