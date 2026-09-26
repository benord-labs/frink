import { describe, expect, it } from 'vitest';
import {
  buildPendingAddState,
  buildPendingReauthState,
  nextApiKeyName,
  providerForAccount,
  shouldUseInlineCredentialEdit,
} from './auth-flow-utils';

describe('buildPendingReauthState', () => {
  it('builds explicit re-auth context for selected account', () => {
    expect(buildPendingReauthState({ id: 'acc-1', label: 'Work Claude' })).toEqual({
      accountId: 'acc-1',
      accountLabel: 'Work Claude',
      mode: 'reauth',
      returnToSettings: true,
      provider: undefined,
    });
  });

  it('preserves empty labels when building re-auth context', () => {
    expect(buildPendingReauthState({ id: 'acc-1', label: '' })).toEqual({
      accountId: 'acc-1',
      accountLabel: '',
      mode: 'reauth',
      returnToSettings: true,
      provider: undefined,
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

  it('routes a codex-passthrough row to the codex connect page (by source)', () => {
    expect(
      buildPendingReauthState({ id: 'acc-3', label: 'OpenAI', source: 'codex-passthrough' }),
    ).toEqual({
      accountId: 'acc-3',
      accountLabel: 'OpenAI',
      mode: 'reauth',
      returnToSettings: true,
      provider: 'codex',
    });
  });
});

describe('providerForAccount', () => {
  it('returns codex for a codex type or codex-passthrough source', () => {
    expect(providerForAccount({ type: 'codex' })).toBe('codex');
    expect(providerForAccount({ source: 'codex-passthrough' })).toBe('codex');
  });

  it('returns undefined (→ Claude) for claude rows', () => {
    expect(providerForAccount({ type: 'claude-code' })).toBeUndefined();
    expect(providerForAccount({ source: 'claude-passthrough' })).toBeUndefined();
  });
});

describe('buildPendingAddState', () => {
  it('leaves the label empty so the connect page names the account after the login', () => {
    expect(buildPendingAddState()).toEqual({
      accountLabel: '',
      mode: 'add',
      returnToSettings: true,
      provider: undefined,
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
