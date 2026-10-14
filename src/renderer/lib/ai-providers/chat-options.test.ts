import { describe, expect, it } from 'vitest';
import {
  CODEX_DEFAULT_MODEL_ID,
  type CodexAccountCatalog,
} from '../../../shared/lib/codex-cli-models';
import { CLAUDE_PICKER_MODELS, CODEX_MODELS } from '../../../shared/lib/models';
import { providerModels, unsupportedChatControls } from './chat-options';

const OPENCODE_MODELS = [
  { id: 'opencode/big-pickle', name: 'Big Pickle' },
  { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
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
});

describe('unsupportedChatControls', () => {
  it.each(['claude-code', 'codex', undefined])('%s keeps every mode and command', (provider) => {
    expect(unsupportedChatControls(provider)).toEqual({ modes: [], commands: [] });
  });

  it('hides Debug and compacting for OpenCode, which keeps Plan', () => {
    expect(unsupportedChatControls('opencode')).toEqual({
      modes: ['debug'],
      commands: ['debug', 'compact'],
    });
  });

  it('also hides Plan for an agent with no plan mode', () => {
    expect(unsupportedChatControls('copilot')).toEqual({
      modes: ['plan', 'debug'],
      commands: ['plan', 'debug', 'compact'],
    });
  });
});
