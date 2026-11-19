/** The phone's composer controls, reading and writing the values main owns through the desktop's
 *  own paths, so each window follows the phone live. */
import { unsupportedModeMessage, unsupportedModes } from '../../../../shared/lib/ai-providers';
import { getAutoModeUnavailableReason } from '../../../../shared/lib/auto-mode-availability';
import {
  type CodexAccountCatalog,
  type CodexAccountTiers,
  codexModelsForAccount,
  codexTierCredits,
  isCodexModelUnavailable,
} from '../../../../shared/lib/codex-cli-models';
import {
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  claudeModelToPickerItem,
  codexModelToPickerItem,
  isClaudeModelVisible,
  isCodexModelVisible,
  normalizeModelIdForExecutionAccount,
} from '../../../../shared/lib/models';
import type { CodexSpeed } from '../../../../shared/types/execution';
import type {
  MobileChatMode,
  MobileComposer,
  MobilePickerModel,
  MobileRequest,
} from '../../../../shared/types/remote/mobile';
import { codexCatalogForModel, codexPlanUsage } from '../../agent-runner/codex/usage';
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

/** The phone's rows, Codex ones limited to what the signed-in account can use (as on desktop). */
function pickerModels(
  provider: 'claude' | 'codex',
  catalog: CodexAccountCatalog | null,
): MobilePickerModel[] {
  return provider === 'codex'
    ? codexModelsForAccount(catalog)
        .filter((m) => isCodexModelVisible(m, NO_HIDDEN_FAMILIES))
        .map(codexModelToPickerItem)
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

/** A paid speed's multiplier on the phone: offered when the account can use it, or kept while it is
 *  on so it can be turned off. Unknown account tiers offer nothing. */
function phoneSpeedCredits(
  modelId: string,
  speed: Exclude<CodexSpeed, 'standard'>,
  current: CodexSpeed | undefined,
  accountTiers: CodexAccountTiers,
): number | null {
  return codexTierCredits(modelId, speed, current === speed ? undefined : accountTiers);
}

/** Debug runs only in a project, and only on a provider that has it. */
function debugAvailable(
  projectId: string | null | undefined,
  accountType: string | undefined,
): boolean {
  return Boolean(projectId) && !unsupportedModes(accountType).includes('debug');
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
  const catalog = provider === 'codex' ? ((await codexPlanUsage.get())?.catalog ?? null) : null;
  const modelId = normalizeModelIdForExecutionAccount(account?.type, stored.modelId, catalog, {
    keepUnavailable: true,
  });
  const tiers = provider === 'codex' ? (catalog?.tiers ?? {}) : null;
  return {
    mode: (subChat.mode as MobileChatMode) ?? 'agent',
    debugAvailable: debugAvailable(chat.projectId, account?.type),
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
    models: pickerModels(provider, catalog),
    settings: { ...stored, modelId },
    autoUnavailableReason: getAutoModeUnavailableReason({
      accountResolved: true,
      isAuthenticated: account?.isAuthenticated,
      accountType: account?.type,
      selectedModelId: modelId,
    }),
    codexSpeedCredits: {
      fast: tiers ? phoneSpeedCredits(modelId, 'fast', stored.codexSpeed, tiers) : null,
      ultrafast: tiers ? phoneSpeedCredits(modelId, 'ultrafast', stored.codexSpeed, tiers) : null,
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
  const isCodexModel = CODEX_MODELS.some((m) => m.id === patch.modelId);
  if (
    isCodexModel &&
    isCodexModelUnavailable(patch.modelId, await codexCatalogForModel(patch.modelId))
  ) {
    throw new MobileApiError(400, "That model isn't available on your ChatGPT plan.");
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
  const account = await mobileCallers.claudeCode.getResolvedAccount({ chatId: chat.id });
  const refusal = unsupportedModeMessage(account?.type, input.mode);
  if (refusal) throw new MobileApiError(400, `${refusal} Pick another mode.`);
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
