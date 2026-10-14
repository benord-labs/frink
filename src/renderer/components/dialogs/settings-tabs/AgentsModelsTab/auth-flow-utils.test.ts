import { describe, expect, it } from 'vitest';
import {
  addAccountLabel,
  buildPendingAddState,
  buildPendingReauthState,
  nextApiKeyName,
  shouldUseInlineCredentialEdit,
  signInProviders,
} from './auth-flow-utils';

describe('buildPendingReauthState', () => {
  it('builds explicit re-auth context for selected account', () => {
    expect(buildPendingReauthState({ id: 'acc-1', label: 'Work Claude' })).toEqual({
      accountId: 'acc-1',
      accountLabel: 'Work Claude',
      mode: 'reauth',
      returnToSettings: true,
      provider: 'claude-code',
    });
  });

  it('preserves empty labels when building re-auth context', () => {
    expect(buildPendingReauthState({ id: 'acc-1', label: '' })).toEqual({
      accountId: 'acc-1',
      accountLabel: '',
      mode: 'reauth',
      returnToSettings: true,
      provider: 'claude-code',
    });
  });

  it('routes a codex row to the codex connect page (by type)', () => {
    expect(buildPendingReauthState({ id: 'acc-2', label: 'OpenAI', type: 'codex' })).toEqual({
      accountId: 'acc-2',
      accountLabel: 'OpenAI',
      mode: 'reauth',
      returnToSettings: true,
      provider: 'codex',
    });
  });

  it.each(['codex', 'opencode'] as const)('routes a %s row to its own connect page', (type) => {
    expect(buildPendingReauthState({ id: 'acc-3', label: 'x', type }).provider).toBe(type);
  });
});

describe('buildPendingAddState', () => {
  it('leaves the label empty so the connect page names the account after the login', () => {
    expect(buildPendingAddState('claude-code')).toEqual({
      accountLabel: '',
      mode: 'add',
      returnToSettings: true,
      provider: 'claude-code',
    });
  });

  it('routes a Codex add to the Codex connect page', () => {
    expect(buildPendingAddState('codex').provider).toBe('codex');
  });
});

describe('shouldUseInlineCredentialEdit', () => {
  it('returns true for API key Claude accounts', () => {
    expect(shouldUseInlineCredentialEdit({ type: 'claude-code', isApiKey: true })).toBe(true);
  });

  it('returns false for Claude OAuth accounts', () => {
    expect(shouldUseInlineCredentialEdit({ type: 'claude-code', isApiKey: false })).toBe(false);
  });

  it('returns false when Claude account isApiKey is omitted', () => {
    expect(shouldUseInlineCredentialEdit({ type: 'claude-code' })).toBe(false);
  });
});

describe('nextApiKeyName', () => {
  it('numbers API-key names past any that are taken', () => {
    expect(nextApiKeyName(['Personal'])).toBe('Claude API key');
    expect(nextApiKeyName(['Claude API key', 'Claude API key 2'])).toBe('Claude API key 3');
  });
});

describe('signInProviders', () => {
  const ON = { codexAccounts: true, opencodeAccounts: true };

  it('offers each switched-on provider this device has not connected yet, in table order', () => {
    expect(signInProviders([], ON, 'darwin')).toEqual(['claude-code', 'codex', 'opencode']);
    expect(signInProviders([{ source: 'opencode-passthrough' }], ON, 'darwin')).toEqual([
      'claude-code',
      'codex',
    ]);
  });

  it('never offers an agent whose flag is off, nor an agent or Claude sign-in on Windows', () => {
    expect(signInProviders([], { codexAccounts: true }, 'darwin')).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(signInProviders([], ON, 'win32')).toEqual(['codex']);
  });

  it('keeps Claude sign-in when only a Claude API key is connected', () => {
    expect(signInProviders([{ source: 'api-key' }], {}, 'darwin')).toEqual(['claude-code']);
  });
});

describe('addAccountLabel', () => {
  it('connects an installed agent and signs in to a provider login', () => {
    expect(addAccountLabel('copilot')).toBe('Connect GitHub Copilot');
    expect(addAccountLabel('opencode')).toBe('Connect OpenCode');
    expect(addAccountLabel('claude-code')).toBe('Sign in with Claude');
    expect(addAccountLabel('codex')).toBe('Sign in with OpenAI');
  });
});
