import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  requireChat: vi.fn(),
  resolved: vi.fn(),
  accounts: vi.fn(),
  setProjectAccount: vi.fn(),
  setDefault: vi.fn(),
  updateSubChatMode: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  thinking: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  requireChat: fixture.requireChat,
  mobileCallers: {
    claudeCode: {
      getResolvedAccount: fixture.resolved,
      listAccounts: fixture.accounts,
      setProjectAccount: fixture.setProjectAccount,
      setDefault: fixture.setDefault,
    },
    chats: { updateSubChatMode: fixture.updateSubChatMode },
  },
}));
vi.mock('../../chat-composer', () => ({
  readComposerSettings: fixture.read,
  updateComposerSettings: fixture.update,
  setThinkingEnabled: fixture.thinking,
  broadcastComposerChange: fixture.broadcast,
}));
vi.mock('../../claude', () => ({
  getBundledClaudeVersion: () => '2.2.0',
  claudeVersionSupportsXhigh: () => true,
}));

import {
  type CodexAccountTiers,
  CODEX_DEFAULT_MODEL_ID,
} from '../../../../shared/lib/codex-cli-models';
import type { CodexUsageSnapshot } from '../../agent-runner/codex/usage/codex-usage';
import { codexPlanUsage } from '../../agent-runner/codex/usage';
import {
  readMobileComposer,
  setMobileAccount,
  setMobileMode,
  updateMobileComposer,
} from './composer';

const identity = { chatId: 'chat', subChatId: 'sub' };
const claudeAccount = {
  id: 'acc-claude',
  label: 'Work',
  type: 'claude-code',
  isAuthenticated: true,
  isProjectOverride: false,
};

function withChat(projectId: string | null) {
  fixture.requireChat.mockResolvedValue({
    chat: { id: 'chat', projectId },
    subChat: { id: 'sub', mode: 'plan' },
  });
}

/** The signed-in Codex account's catalog, as the usage probe would report it. */
function codexTiers(tiers: CodexAccountTiers, defaultSlug: string | null = null): void {
  const snapshot: CodexUsageSnapshot = {
    windows: {},
    subscriptionType: 'plus',
    email: null,
    available: true,
    updatedAt: 0,
    catalog: { tiers, defaultSlug },
  };
  vi.spyOn(codexPlanUsage, 'get').mockResolvedValue(snapshot);
}

/** A free ChatGPT login's model/list (bundled Codex 0.155.1): no GPT-6 Astra, no paid speeds. */
const FREE_TIERS: CodexAccountTiers = {
  'gpt-6-luna': [],
  'gpt-5.6-terra': [],
  'gpt-5.6-luna': [],
  'gpt-5.5': [],
  'codex-auto-review': [],
};

beforeEach(() => {
  vi.clearAllMocks();
  withChat('project');
  fixture.resolved.mockResolvedValue(claudeAccount);
  fixture.accounts.mockResolvedValue([
    { ...claudeAccount, isDefault: true, extra: 'not sent to the phone' },
  ]);
  fixture.read.mockReturnValue({
    modelId: 'opus-4.8',
    autoMode: true,
    codexSpeed: 'ultrafast',
    thinkingEnabled: true,
  });
  fixture.update.mockReturnValue({});
  codexTiers({ 'gpt-6-astra': ['fast', 'ultrafast'] });
});

describe('phone composer', () => {
  it('reports the chat’s mode, settings and the Claude catalog for a Claude account', async () => {
    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer).toMatchObject({
      mode: 'plan',
      debugAvailable: true,
      provider: 'claude',
      projectId: 'project',
      // The phone sees the chat's real speed, so an Ultrafast chat never reads as Fast-off.
      settings: {
        modelId: 'opus-4.8',
        autoMode: true,
        codexSpeed: 'ultrafast',
        thinkingEnabled: true,
      },
      autoUnavailableReason: '',
      codexSpeedCredits: { fast: null, ultrafast: null },
    });
    expect(composer.models.some((m) => m.id === 'opus-4.8')).toBe(true);
    expect(composer.accounts).toEqual([
      {
        id: 'acc-claude',
        label: 'Work',
        type: 'claude-code',
        isDefault: true,
        isAuthenticated: true,
      },
    ]);
  });

  it('shows a Claude choice as the Codex default on a Codex account without storing it', async () => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer.provider).toBe('codex');
    expect(composer.settings.modelId).toBe(CODEX_DEFAULT_MODEL_ID);
    expect(composer.codexSpeedCredits).toEqual({ fast: 2.5, ultrafast: 8 });
    expect(composer.models.every((m) => m.id !== 'opus-4.8')).toBe(true);
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it("offers only the account's paid speeds, keeping the one the chat is on", async () => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });
    codexTiers({ 'gpt-6-astra': [] });

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    // The stored chat is on Ultrafast, so it stays switchable-off; Fast is not offered.
    expect(composer.codexSpeedCredits).toEqual({ fast: null, ultrafast: 8 });
  });

  it('offers no paid speed when the account tiers could not be read', async () => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });
    fixture.read.mockReturnValue({ modelId: CODEX_DEFAULT_MODEL_ID, codexSpeed: 'standard' });
    vi.spyOn(codexPlanUsage, 'get').mockResolvedValue(null);

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer.codexSpeedCredits).toEqual({ fast: null, ultrafast: null });
  });

  it('writes settings through main and Thinking app-wide', async () => {
    await updateMobileComposer({
      type: 'updateComposer',
      ...identity,
      patch: { modelId: 'sonnet', autoMode: false, thinkingEnabled: false },
    });

    expect(fixture.update).toHaveBeenCalledWith('chat', { modelId: 'sonnet', autoMode: false });
    expect(fixture.thinking).toHaveBeenCalledWith(false);
  });

  it('writes every Codex speed the phone picks', async () => {
    for (const codexSpeed of ['fast', 'ultrafast', 'standard'] as const) {
      await updateMobileComposer({ type: 'updateComposer', ...identity, patch: { codexSpeed } });
      expect(fixture.update).toHaveBeenLastCalledWith('chat', { codexSpeed });
    }
  });

  it("lists only the models a free account can use, keeping a saved one it can't", async () => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });
    fixture.read.mockReturnValue({ modelId: CODEX_DEFAULT_MODEL_ID, codexSpeed: 'standard' });
    codexTiers(FREE_TIERS, 'gpt-6-luna');

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer.models.some((m) => m.id.startsWith('codex-gpt-6-astra'))).toBe(false);
    expect(composer.models.some((m) => m.id === 'codex-gpt-6-luna-medium')).toBe(true);
    expect(composer.settings.modelId).toBe(CODEX_DEFAULT_MODEL_ID);
  });

  it('starts a Codex chat with no Codex model on the account default', async () => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });
    codexTiers(FREE_TIERS, 'gpt-6-luna');

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer.settings.modelId).toBe('codex-gpt-6-luna-medium');
  });

  it('lists every Codex model while the account catalog is unknown', async () => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });
    vi.spyOn(codexPlanUsage, 'get').mockResolvedValue(null);

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer.models.some((m) => m.id === CODEX_DEFAULT_MODEL_ID)).toBe(true);
  });

  it("refuses a Codex model the account can't use", async () => {
    codexTiers(FREE_TIERS);

    await expect(
      updateMobileComposer({
        type: 'updateComposer',
        ...identity,
        patch: { modelId: CODEX_DEFAULT_MODEL_ID },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it('refuses a model id that is in neither catalog', async () => {
    await expect(
      updateMobileComposer({ type: 'updateComposer', ...identity, patch: { modelId: 'gpt-9' } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it('switches mode through the desktop route, and only allows Debug with a project', async () => {
    await setMobileMode({ type: 'setMode', ...identity, mode: 'debug' });
    expect(fixture.updateSubChatMode).toHaveBeenCalledWith({ id: 'sub', mode: 'debug' });

    withChat(null);
    await expect(
      setMobileMode({ type: 'setMode', ...identity, mode: 'debug' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('hides Debug on an OpenAI chat in a project', async () => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer.debugAvailable).toBe(false);
  });

  it.each([
    ['plan', 'Plan'],
    ['debug', 'Debug'],
  ] as const)('refuses %s on an OpenAI chat and keeps its mode', async (mode, name) => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type: 'codex' });

    await expect(setMobileMode({ type: 'setMode', ...identity, mode })).rejects.toMatchObject({
      status: 400,
      message: `${name} mode isn't available for OpenAI yet. Pick another mode.`,
    });
    expect(fixture.updateSubChatMode).not.toHaveBeenCalled();
  });

  it('scopes an account switch to the project, or changes the default without one', async () => {
    await setMobileAccount({ type: 'setAccount', ...identity, accountId: 'acc-2' });
    expect(fixture.setProjectAccount).toHaveBeenCalledWith({
      projectId: 'project',
      accountId: 'acc-2',
    });
    // Desktop windows refetch the account now instead of when their cache expires.
    expect(fixture.broadcast).toHaveBeenCalledWith({ kind: 'accounts', projectId: 'project' });

    withChat(null);
    await setMobileAccount({ type: 'setAccount', ...identity, accountId: 'acc-2' });
    expect(fixture.setDefault).toHaveBeenCalledWith({ id: 'acc-2' });
  });

  it.each([
    ['claude-code', 'claude', 'sonnet', ''],
    ['codex', 'codex', CODEX_DEFAULT_MODEL_ID, ''],
    [
      'opencode',
      'claude',
      'anthropic/claude-sonnet-4-5',
      'The selected provider or model does not support Auto Mode.',
    ],
  ])('on %s, sends provider %s and model %s', async (type, provider, modelId, autoReason) => {
    fixture.resolved.mockResolvedValue({ ...claudeAccount, type });
    fixture.read.mockReturnValue({ modelId: 'anthropic/claude-sonnet-4-5', autoMode: true });

    const composer = await readMobileComposer({ type: 'composer', ...identity });

    expect(composer.provider).toBe(provider);
    expect(composer.settings.modelId).toBe(modelId);
    expect(composer.autoUnavailableReason).toBe(autoReason);
  });
});
