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

import { CODEX_DEFAULT_MODEL_ID } from '../../../../shared/lib/codex-cli-models';
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
});
