import { type AiProviderId, aiProvider, isInstalledAgent } from '../../../shared/lib/ai-providers';
import {
  type CodexAccountCatalog,
  codexModelsForAccount,
  isCodexModelUnavailable,
} from '../../../shared/lib/codex-cli-models';
import {
  agentRefusesModel,
  modelRowFor,
  type PickerGroupFields,
} from '../../../shared/lib/model-picker-label/groups';
import {
  AGENT_DEFAULT_MODEL_ID,
  CLAUDE_CODE_MODELS,
  CODEX_MODELS,
  claudeModelToPickerItem,
  codexModelToPickerItem,
  isClaudeModelVisible,
  isCodexModelVisible,
  normalizeModelIdForExecutionAccount,
} from '../../../shared/lib/models';
import type { ChatMode } from '../../../shared/types/chat-mode';

type ProviderModelItem = PickerGroupFields & { detail?: string; version?: string };
/** Which picker to show: Claude's, Codex's, or an agent's own flat list (named by its id). */
export type ModelVariant = 'claude' | 'codex' | AiProviderId;

type ProviderModels = {
  items: ProviderModelItem[];
  selected: ProviderModelItem;
  variant: ModelVariant;
  /** The saved Codex model is one the signed-in account can't use; its send will be refused. */
  unavailable: boolean;
  /** Shown under an agent's list before the agent has said which models it offers. */
  hint?: string;
  /** Agents only: the agent's turn refuses the saved model, so a new chat starts on its default. */
  refusesModel?: boolean;
};

type ProviderModelInputs = {
  modelId: string;
  hiddenFamilies: string[];
  codexCatalog: CodexAccountCatalog | null | undefined;
  /** The models an agent listed in its last session, when it has run. */
  agentModels: readonly ProviderModelItem[] | undefined;
  /** Keep a saved Codex model the account can't use (an open chat) instead of its default. */
  keepUnavailable: boolean;
};

function claudeModels({ modelId, hiddenFamilies }: ProviderModelInputs): ProviderModels {
  const items = CLAUDE_CODE_MODELS.filter((m) => isClaudeModelVisible(m, hiddenFamilies)).map(
    claudeModelToPickerItem,
  );
  const selected =
    items.find((m) => m.id === modelId) ??
    items[0] ??
    claudeModelToPickerItem(CLAUDE_CODE_MODELS[0]);
  return { items, selected, variant: 'claude', unavailable: false };
}

function codexModels(inputs: ProviderModelInputs): ProviderModels {
  const { codexCatalog, hiddenFamilies, keepUnavailable } = inputs;
  const visible = codexModelsForAccount(codexCatalog).filter((m) =>
    isCodexModelVisible(m, hiddenFamilies),
  );
  const id = normalizeModelIdForExecutionAccount('codex', inputs.modelId, codexCatalog ?? null, {
    keepUnavailable,
  });
  const unavailable = isCodexModelUnavailable(id, codexCatalog);
  const model = unavailable
    ? CODEX_MODELS.find((m) => m.id === id)
    : (visible.find((m) => m.id === id) ?? visible[0]);
  return {
    items: visible.map(codexModelToPickerItem),
    selected: codexModelToPickerItem(model ?? CODEX_MODELS[0]),
    variant: 'codex',
    unavailable,
  };
}

/** The picker rows and selection for a chat on `providerId`; agents list their own models flat. */
export function providerModels(
  providerId: string | null | undefined,
  inputs: ProviderModelInputs,
): ProviderModels {
  const row = aiProvider(providerId);
  if (row?.runtime === 'codex') return codexModels(inputs);
  if (!isInstalledAgent(row)) return claudeModels(inputs);
  const listed = inputs.agentModels ?? [];
  const { offered, row: runs } = modelRowFor(listed, inputs.modelId);
  // Copilot runs the saved effort, else the model's default, else its own: then no tier shows.
  const copilotRow = runs ?? (offered && { id: inputs.modelId, name: offered.name });
  const chosen =
    row.runtime === 'copilot' ? copilotRow : listed.find((m) => m.id === inputs.modelId);
  // The turn refuses a model the agent no longer offers; this row sends none.
  const fallback = { id: AGENT_DEFAULT_MODEL_ID, name: `${row.name} default` };
  return {
    items: chosen ? [...listed] : [fallback, ...listed],
    selected: chosen ?? fallback,
    variant: row.id,
    unavailable: false,
    hint: listed.length > 0 ? undefined : `Send a message to load ${row.name}'s models.`,
    refusesModel: agentRefusesModel(listed, inputs.modelId, row.runtime === 'copilot'),
  };
}

type UnsupportedChatControls = { modes: ChatMode[]; commands: string[] };

/** Chat modes and built-in commands an agent has no equivalent for, so its chats hide them. */
export function unsupportedChatControls(
  providerId: string | null | undefined,
): UnsupportedChatControls {
  const row = aiProvider(providerId);
  if (!isInstalledAgent(row)) return { modes: [], commands: [] };
  const modes: ChatMode[] = row.planMode ? ['debug'] : ['plan', 'debug'];
  return { modes, commands: [...modes, 'compact'] };
}
