import { describe, expect, it } from 'vitest';
import {
  CODEX_DEFAULT_MODEL_ID,
  type CodexAccountCatalog,
} from '../../../shared/lib/codex-cli-models';
import type { PickerGroupFields } from '../../../shared/lib/model-picker-label/groups';
import {
  AGENT_DEFAULT_MODEL_ID,
  CLAUDE_PICKER_MODELS,
  CODEX_MODELS,
} from '../../../shared/lib/models';
import { agentModelFamilies, providerModels, unsupportedChatControls } from './chat-options';

const OPENCODE_MODELS = [
  { id: 'opencode/big-pickle', name: 'Big Pickle' },
  { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
];
const GPT_5 = { name: 'GPT-5', familyId: 'gpt-5' };
const COPILOT_MODELS = [
  { ...GPT_5, id: 'gpt-5/low', effort: 'low' as const },
  { ...GPT_5, id: 'gpt-5/high', effort: 'high' as const },
  { id: 'auto', name: 'Auto' },
];
const OPUS = { name: 'Claude Opus 5.5', familyId: 'claude-opus-5-5' };
const CURSOR_MODELS: PickerGroupFields[] = [
  { id: 'default', name: 'Auto' },
  { ...OPUS, id: 'claude-opus-5-5/low', effort: 'low' },
  { ...OPUS, id: 'claude-opus-5-5/medium', effort: 'medium', effortDefault: true },
];
const FREE_CODEX: CodexAccountCatalog = {
  tiers: { 'gpt-6-luna': [], 'gpt-5.5': [] },
  defaultSlug: 'gpt-6-luna',
};

function models(
  providerId: string | undefined,
  modelId: string,
  more: Partial<Parameters<typeof providerModels>[1]> = {},
) {
  return providerModels(providerId, {
    modelId,
    hiddenFamilies: [],
    codexCatalog: null,
    agentModels: undefined,
    keepUnavailable: false,
    ...more,
  });
}

describe('providerModels', () => {
  it.each([
    ['claude-code', 'opus', 'claude', CLAUDE_PICKER_MODELS.length],
    [undefined, 'opus', 'claude', CLAUDE_PICKER_MODELS.length],
    ['codex', CODEX_DEFAULT_MODEL_ID, 'codex', CODEX_MODELS.length],
  ])('%s keeps its own catalog and selection', (provider, id, variant, count) => {
    const result = models(provider, id);
    expect(result).toMatchObject({ variant, unavailable: false });
    expect(result.hint).toBeUndefined();
    expect(result.items).toHaveLength(count);
    expect(result.selected?.id).toBe(id);
  });

  it('leaves out hidden Claude families and falls back to the first visible model', () => {
    const result = models('claude-code', 'opus', { hiddenFamilies: ['opus-4.6'] });
    expect(result.items.some((m) => m.familyId === 'opus-4.6')).toBe(false);
    expect(result.selected).toEqual(result.items[0]);
  });

  it("names a saved Codex model the account can't use, or snaps to the account default", () => {
    const kept = models('codex', CODEX_DEFAULT_MODEL_ID, {
      codexCatalog: FREE_CODEX,
      keepUnavailable: true,
    });
    expect(kept.unavailable).toBe(true);
    expect(kept.selected?.id).toBe(CODEX_DEFAULT_MODEL_ID);

    const snapped = models('codex', CODEX_DEFAULT_MODEL_ID, { codexCatalog: FREE_CODEX });
    expect(snapped.unavailable).toBe(false);
    expect(snapped.selected?.id).toBe('codex-gpt-6-luna-medium');
  });

  it("shows OpenCode's default and how to load its list before any message", () => {
    expect(models('opencode', 'sonnet')).toEqual({
      items: [{ id: 'sonnet', name: 'OpenCode default' }],
      selected: { id: 'sonnet', name: 'OpenCode default' },
      variant: 'opencode',
      unavailable: false,
      hint: "Send a message to load OpenCode's models.",
      refusesModel: false,
    });
  });

  it("lists OpenCode's own models flat, keeping an agent id as it is", () => {
    const result = models('opencode', 'anthropic/claude-sonnet-4-5', {
      agentModels: OPENCODE_MODELS,
    });
    expect(result.items).toEqual(OPENCODE_MODELS);
    expect(result.selected).toEqual(OPENCODE_MODELS[1]);
    expect(result.hint).toBeUndefined();
  });

  it('shows the default above the list when the saved id is not one OpenCode lists', () => {
    const result = models('opencode', 'sonnet', { agentModels: OPENCODE_MODELS });
    expect(result.selected).toEqual({ id: 'sonnet', name: 'OpenCode default' });
    expect(result.items).toEqual([result.selected, ...OPENCODE_MODELS]);
  });

  it("lists GitHub Copilot's own models, never Claude's", () => {
    const listed = [{ id: 'gpt-5', name: 'GPT-5' }];
    expect(models('copilot', 'gpt-5', { agentModels: listed })).toMatchObject({
      items: listed,
      selected: listed[0],
      variant: 'copilot',
    });
    expect(models('copilot', 'opus').items).toEqual([
      { id: 'sonnet', name: 'GitHub Copilot default' },
    ]);
  });

  it.each(['gpt-5', 'gpt-5/xhigh'])(
    "shows Copilot's %s as the model's default effort, which the turn runs",
    (id) => {
      const tier = { name: 'GPT-5', familyId: 'gpt-5' };
      const listed = [
        { ...tier, id: 'gpt-5/low', effort: 'low' as const },
        { ...tier, id: 'gpt-5/medium', effort: 'medium' as const, effortDefault: true as const },
      ];
      expect(models('copilot', id, { agentModels: listed }).selected).toEqual(listed[1]);
    },
  );

  it('names a Copilot model with several efforts and no default, not the agent default', () => {
    const tier = { name: 'GPT-X', familyId: 'gpt-x' };
    const listed = [
      { ...tier, id: 'gpt-x/low', effort: 'low' as const },
      { ...tier, id: 'gpt-x/high', effort: 'high' as const },
    ];
    const result = models('copilot', 'gpt-x', { agentModels: listed });
    expect(result.selected).toEqual({ id: 'gpt-x', name: 'GPT-X' });
    expect(result.items).toEqual(listed);
    expect(result.refusesModel).toBe(false);
  });

  it("refuses another agent's model only once the agent's saved list lacks it", () => {
    const foreign = OPENCODE_MODELS[1].id;
    const listed = [{ id: 'gpt-5', name: 'GPT-5' }];
    for (const agentModels of [undefined, []]) {
      const result = models('copilot', foreign, { agentModels });
      expect(result.selected).toEqual({
        id: AGENT_DEFAULT_MODEL_ID,
        name: 'GitHub Copilot default',
      });
      expect(result.refusesModel).toBe(false);
    }
    expect(models('copilot', foreign, { agentModels: listed }).refusesModel).toBe(true);
  });

  it("never refuses Claude's model on an agent chat: the turn leaves it out", () => {
    const result = models('opencode', 'opus', { agentModels: OPENCODE_MODELS });
    expect(result.selected).toEqual({ id: AGENT_DEFAULT_MODEL_ID, name: 'OpenCode default' });
    expect(result.refusesModel).toBe(false);
  });

  it('leaves out an agent model switched off in Settings', () => {
    const result = models('opencode', 'opencode/big-pickle', {
      agentModels: OPENCODE_MODELS,
      hiddenFamilies: ['opencode:anthropic/claude-sonnet-4-5'],
    });
    expect(result.items).toEqual([OPENCODE_MODELS[0]]);
  });

  it('leaves out every effort row of a switched-off Copilot model', () => {
    const result = models('copilot', 'auto', {
      agentModels: COPILOT_MODELS,
      hiddenFamilies: ['copilot:gpt-5'],
    });
    expect(result.items).toEqual([COPILOT_MODELS[2]]);
  });

  it('starts a new chat on the last-picked model even when it is switched off', () => {
    const result = models('opencode', 'opencode/big-pickle', {
      agentModels: OPENCODE_MODELS,
      hiddenFamilies: ['opencode:opencode/big-pickle'],
      keepUnavailable: false,
    });
    expect(result.items).toEqual(OPENCODE_MODELS);
    expect(result.selected).toEqual(OPENCODE_MODELS[0]);
  });

  it('lists every model when all of them are switched off', () => {
    const result = models('opencode', 'gone', {
      agentModels: OPENCODE_MODELS,
      hiddenFamilies: agentModelFamilies('opencode', OPENCODE_MODELS).map((f) => f.id),
    });
    expect(result.items).toEqual([
      { id: AGENT_DEFAULT_MODEL_ID, name: 'OpenCode default' },
      ...OPENCODE_MODELS,
    ]);
    expect(result.hint).toBeUndefined();
  });

  it('keeps a switched-off model the chat is set to, with all its effort rows', () => {
    const result = models('copilot', 'gpt-5/high', {
      agentModels: COPILOT_MODELS,
      hiddenFamilies: ['copilot:gpt-5', 'copilot:auto'],
    });
    expect(result.items).toEqual(COPILOT_MODELS.slice(0, 2));
    expect(result.selected).toEqual(COPILOT_MODELS[1]);
  });

  it("lists Cursor's own models, Auto first, showing a saved model at the effort its turn runs", () => {
    expect(models('cursor', 'claude-opus-5-5', { agentModels: CURSOR_MODELS })).toMatchObject({
      items: CURSOR_MODELS,
      selected: CURSOR_MODELS[2],
      variant: 'cursor',
      refusesModel: false,
    });
    expect(models('cursor', 'default', { agentModels: CURSOR_MODELS }).selected).toEqual(
      CURSOR_MODELS[0],
    );
  });

  it('refuses a saved Cursor model only once Cursor no longer lists it, whatever the effort', () => {
    const listed = { agentModels: CURSOR_MODELS };
    expect(models('cursor', 'claude-opus-5-5/max', listed).refusesModel).toBe(false);
    expect(models('cursor', 'grok-3/high', listed).refusesModel).toBe(true);
  });

  it('hides a model only for the agent that lists it', () => {
    const hiddenFamilies = agentModelFamilies('copilot', [
      ...COPILOT_MODELS,
      { id: 'opus-4.6', name: 'Opus 4.6' },
    ]).map((f) => f.id);
    const opencode = [OPENCODE_MODELS[0], { id: 'gpt-5', name: 'GPT-5' }];
    expect(
      models('opencode', opencode[0].id, { agentModels: opencode, hiddenFamilies }).items,
    ).toEqual(opencode);
    expect(models('claude-code', 'opus', { hiddenFamilies }).items).toHaveLength(
      CLAUDE_PICKER_MODELS.length,
    );
  });
});

describe('agentModelFamilies', () => {
  it('gives one switch per model, never one per effort', () => {
    expect(agentModelFamilies('copilot', COPILOT_MODELS)).toEqual([
      { id: 'copilot:gpt-5', name: 'GPT-5' },
      { id: 'copilot:auto', name: 'Auto' },
    ]);
    expect(agentModelFamilies('cursor', CURSOR_MODELS)).toEqual([
      { id: 'cursor:default', name: 'Auto' },
      { id: 'cursor:claude-opus-5-5', name: 'Claude Opus 5.5' },
    ]);
  });
});

describe('unsupportedChatControls', () => {
  it.each(['claude-code', 'codex', undefined])('%s keeps every mode and command', (provider) => {
    expect(unsupportedChatControls(provider)).toEqual({ modes: [], commands: [] });
  });

  it.each(['opencode', 'copilot'])('hides Debug and compacting for %s, which keeps Plan', (id) => {
    expect(unsupportedChatControls(id)).toEqual({
      modes: ['debug'],
      commands: ['debug', 'compact'],
    });
  });

  it('also hides Plan for an agent with no plan mode', () => {
    expect(unsupportedChatControls('grok')).toEqual({
      modes: ['plan', 'debug'],
      commands: ['plan', 'debug', 'compact'],
    });
  });
});
