import { aiProvider, unsupportedModeMessage } from '../../../shared/lib/ai-providers';
import { type ResolvedTaskStartMode, toChatMode } from '../../../shared/lib/trigger-rule-config';
import {
  getClaudeCodeTokenById,
  getDefaultClaudeCodeToken,
  isResolvedCredential,
} from '../credentials';
import { getDatabase } from '../db';
import { getChatWithProjectAccount } from '../db/repos/chats';
import { getProjectAiAccount } from '../db/repos/project-ai-accounts';

export type TaskExecutionAccountType = 'claude-code' | 'codex';

type TaskAccount = { id: string; label: string | null } | null;

/** Credential `type` → task execution account type. Flows run only on Claude and Codex, and only
 * in a mode the provider has. */
export function toTaskAccountType(
  credType: string,
  startMode: ResolvedTaskStartMode,
): TaskExecutionAccountType {
  const provider = aiProvider(credType);
  if (provider?.id === 'claude-code' || provider?.id === 'codex') {
    const refusal = unsupportedModeMessage(provider.id, toChatMode(startMode));
    if (!refusal) return provider.id;
    throw Object.assign(new Error(`${refusal} Pick another mode.`), { permanent: true });
  }
  const name = provider?.name ?? 'This AI provider';
  const err = new Error(`${name} can't run Flows yet. Pick Claude or OpenAI for this project.`);
  throw Object.assign(err, { permanent: true });
}

/** A continued chat runs on its own stamped account; a new chat is stamped from the project. */
export async function resolveTaskAccount(
  localProjectId: string | null,
  chatId: string | null,
): Promise<TaskAccount> {
  if (chatId) return (await getChatWithProjectAccount(getDatabase(), chatId))?.account ?? null;
  return localProjectId ? getProjectAiAccount(getDatabase(), localProjectId) : null;
}

/**
 * The provider a task runs on (null account = the workspace default). An account not connected on
 * this machine fails the task: no silent fallback. Codex's real auth gate is the spawn-time probe.
 */
export async function resolveTaskAccountType(
  account: TaskAccount,
  { startMode }: { startMode: ResolvedTaskStartMode },
): Promise<TaskExecutionAccountType> {
  if (!account) return toTaskAccountType((await getDefaultClaudeCodeToken()).type, startMode);
  const cred = await getClaudeCodeTokenById(account.id);
  if (isResolvedCredential(cred)) return toTaskAccountType(cred.type, startMode);
  const err = new Error(
    `Account "${account.label ?? 'Unnamed account'}" is not authenticated on this machine. ` +
      `Please connect or authenticate it, then retry the task.`,
  );
  // The action lets the notification offer a "Connect account" CTA instead of a Settings hunt.
  throw Object.assign(err, { action: 'open-connect-account', permanent: true });
}
