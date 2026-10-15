import {
  type AiProviderId,
  aiProvider,
  isInstalledAgent,
  unsupportedModes,
} from '../../../shared/lib/ai-providers';
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

/** An agent model's id in the hidden-models setting; a model's effort rows share it. */
function agentModelKey(agentId: string, model: { id: string; familyId?: string }): string {
  return `${agentId}:${model.familyId ?? model.id}`;
}

/** One switchable entry per model an agent lists, named after its first row. */
export function agentModelFamilies(
  agentId: string,
  rows: readonly PickerGroupFields[],
): { id: string; name: string }[] {
  const names = new Map<string, string>();
  for (const row of rows) {
    const id = agentModelKey(agentId, row);
    if (!names.has(id)) names.set(id, row.name);
  }
  return [...names].map(([id, name]) => ({ id, name }));
}

/** The picker rows and selection for a chat on `providerId`; agents list their own models flat. */
export function providerModels(
  providerId: string | null | undefined,
  inputs: ProviderModelInputs,
): ProviderModels {
  const row = aiProvider(providerId);
  if (row?.runtime === 'codex') return codexModels(inputs);
  if (!isInstalledAgent(row)) return claudeModels(inputs);
  const reported = inputs.agentModels ?? [];
  const { offered, row: runs } = modelRowFor(reported, inputs.modelId);
  const byEffort = row.runtime === 'copilot' || row.runtime === 'cursor';
  // These run the saved effort, else the model's default, else their own: then no tier shows.
  const effortRow = runs ?? (offered && { id: inputs.modelId, name: offered.name });
  const chosen = byEffort ? effortRow : reported.find((m) => m.id === inputs.modelId);
  // A chat already set to a switched-off model keeps it.
  const kept = chosen && agentModelKey(row.id, chosen);
  const visible = reported.filter((m) => {
    const key = agentModelKey(row.id, m);
    return key === kept || !inputs.hiddenFamilies.includes(key);
  });
  // The agent's list can change after the switches were set, so never let them empty it.
  const listed = visible.length > 0 ? visible : reported;
  // The turn refuses a model the agent no longer offers; this row sends none.
  const fallback = { id: AGENT_DEFAULT_MODEL_ID, name: `${row.name} default` };
  return {
    items: chosen ? [...listed] : [fallback, ...listed],
    selected: chosen ?? fallback,
    variant: row.id,
    unavailable: false,
    hint: listed.length > 0 ? undefined : `Send a message to load ${row.name}'s models.`,
    refusesModel: agentRefusesModel(reported, inputs.modelId, byEffort),
  };
}

type UnsupportedChatControls = { modes: ChatMode[]; commands: string[] };

/** Chat modes and built-in commands an agent has no equivalent for, so its chats hide them. */
export function unsupportedChatControls(
  providerId: string | null | undefined,
): UnsupportedChatControls {
  const modes = unsupportedModes(providerId);
  const commands = isInstalledAgent(aiProvider(providerId)) ? [...modes, 'compact'] : modes;
  return { modes, commands };
}
