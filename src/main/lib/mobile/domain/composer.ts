/** The phone's composer controls, reading and writing the values main owns through the desktop's
 *  own paths, so each window follows the phone live. */
import { getAutoModeUnavailableReason } from '../../../../shared/lib/auto-mode-availability';
import { codexTierCredits } from '../../../../shared/lib/codex-cli-models';
import {
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  claudeModelToPickerItem,
  codexModelToPickerItem,
  isClaudeModelVisible,
  isCodexModelVisible,
  normalizeModelIdForExecutionAccount,
} from '../../../../shared/lib/models';
import type {
  MobileChatMode,
  MobileComposer,
  MobilePickerModel,
  MobileRequest,
} from '../../../../shared/types/remote/mobile';
import {
  broadcastComposerChange,
  readComposerSettings,
  setThinkingEnabled,
  updateComposerSettings,
} from '../../chat-composer';
import {
  claudeVersionSupportsUltra,
  claudeVersionSupportsXhigh,
  getBundledClaudeVersion,
} from '../../claude';
import { MobileApiError, mobileCallers, requireChat } from './context';

type ComposerRequest = Extract<MobileRequest, { type: 'composer' }>;
type UpdateComposerRequest = Extract<MobileRequest, { type: 'updateComposer' }>;
type SetModeRequest = Extract<MobileRequest, { type: 'setMode' }>;
type SetAccountRequest = Extract<MobileRequest, { type: 'setAccount' }>;

// The desktop hides no family by default; per-window hidden families stay a desktop preference.
const NO_HIDDEN_FAMILIES: string[] = [];

function pickerModels(provider: 'claude' | 'codex'): MobilePickerModel[] {
  return provider === 'codex'
    ? CODEX_MODELS.filter((m) => isCodexModelVisible(m, NO_HIDDEN_FAMILIES)).map(
        codexModelToPickerItem,
      )
    : CLAUDE_CODE_MODELS.filter((m) => isClaudeModelVisible(m, NO_HIDDEN_FAMILIES)).map(
        claudeModelToPickerItem,
      );
}

function xhighSupported(): boolean {
  try {
    return claudeVersionSupportsXhigh(getBundledClaudeVersion());
  } catch {
    return true; // Desktop's default while unknown; the executor clamps xhigh as the backstop.
  }
}

function ultraSupported(): boolean {
  try {
    return claudeVersionSupportsUltra(getBundledClaudeVersion());
  } catch {
    return true; // Desktop's default while unknown; the executor drops Ultra as the backstop.
  }
}

export async function readMobileComposer(input: ComposerRequest): Promise<MobileComposer> {
  const { chat, subChat } = await requireChat(input.chatId, input.subChatId);
  const [account, accounts] = await Promise.all([
    mobileCallers.claudeCode.getResolvedAccount({ chatId: chat.id }),
    mobileCallers.claudeCode.listAccounts(),
  ]);
  const stored = readComposerSettings(chat.id);
  if (!stored) throw new MobileApiError(404, 'Chat not found.');
  const provider = account?.type === 'codex' ? 'codex' : 'claude';
  // Shown normalized (as the desktop picker does) but never stored normalized: flipping the
  // account back must not lose the other provider's choice.
  const modelId = normalizeModelIdForExecutionAccount(provider === 'codex', stored.modelId);
  return {
    mode: (subChat.mode as MobileChatMode) ?? 'agent',
    debugAvailable: Boolean(chat.projectId),
    provider,
    account: account
      ? {
          id: account.id ?? null,
          label: account.label,
          type: account.type,
          isAuthenticated: account.isAuthenticated,
          isProjectOverride: account.isProjectOverride,
        }
      : null,
    projectId: chat.projectId ?? null,
    accounts: accounts.map(({ id, label, type, isDefault, isAuthenticated }) => ({
      id,
      label,
      type,
      isDefault,
      isAuthenticated,
    })),
    models: pickerModels(provider),
    settings: { ...stored, modelId },
    autoUnavailableReason: getAutoModeUnavailableReason({
      accountResolved: true,
      isAuthenticated: account?.isAuthenticated,
      accountType: account?.type === 'codex' ? 'codex' : account ? 'claude-code' : undefined,
      selectedModelId: modelId,
    }),
    codexSpeedCredits: {
      fast: provider === 'codex' ? codexTierCredits(modelId, 'fast') : null,
      ultrafast: provider === 'codex' ? codexTierCredits(modelId, 'ultrafast') : null,
    },
    xhighSupported: xhighSupported(),
    ultraSupported: ultraSupported(),
  };
}

export async function updateMobileComposer(input: UpdateComposerRequest): Promise<MobileComposer> {
  const { chat } = await requireChat(input.chatId, input.subChatId);
  const { thinkingEnabled, ...patch } = input.patch;
  if (patch.modelId !== undefined && !isKnownModel(patch.modelId)) {
    throw new MobileApiError(400, 'That model is not available.');
  }
  if (Object.keys(patch).length > 0 && !updateComposerSettings(chat.id, patch)) {
    throw new MobileApiError(404, 'Chat not found.');
  }
  if (thinkingEnabled !== undefined) setThinkingEnabled(thinkingEnabled);
  return readMobileComposer({ type: 'composer', chatId: chat.id, subChatId: input.subChatId });
}

export async function setMobileMode(input: SetModeRequest): Promise<MobileComposer> {
  const { chat, subChat } = await requireChat(input.chatId, input.subChatId);
  if (input.mode === 'debug' && !chat.projectId) {
    throw new MobileApiError(400, 'Debug mode needs a project.');
  }
  // The desktop's own route: it writes the row under the sub-chat lock and echoes to every window.
  await mobileCallers.chats.updateSubChatMode({ id: subChat.id, mode: input.mode });
  return readMobileComposer({ type: 'composer', chatId: chat.id, subChatId: subChat.id });
}

export async function setMobileAccount(input: SetAccountRequest): Promise<MobileComposer> {
  const { chat, subChat } = await requireChat(input.chatId, input.subChatId);
  if (chat.projectId) {
    await mobileCallers.claudeCode.setProjectAccount({
      projectId: chat.projectId,
      accountId: input.accountId,
    });
  } else if (input.accountId) {
    // A chat without a project runs on the default account, as on desktop.
    await mobileCallers.claudeCode.setDefault({ id: input.accountId });
  } else {
    throw new MobileApiError(400, 'Choose an account.');
  }
  // Desktop windows cache the resolved account; refetch now rather than when the cache expires.
  broadcastComposerChange({ kind: 'accounts', projectId: chat.projectId ?? null });
  return readMobileComposer({ type: 'composer', chatId: chat.id, subChatId: subChat.id });
}

function isKnownModel(modelId: string): boolean {
  return (
    CLAUDE_CODE_MODELS.some((m) => m.id === modelId) || CODEX_MODELS.some((m) => m.id === modelId)
  );
}
