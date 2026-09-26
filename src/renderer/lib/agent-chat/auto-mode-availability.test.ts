import { describe, expect, it } from 'vitest';
import { getAutoModeUnavailableReason } from './auto-mode-availability';

const SUPPORTED = {
  accountResolved: true,
  isAuthenticated: true,
  accountType: 'claude-code',
  selectedModelId: 'sonnet',
};

describe('getAutoModeUnavailableReason', () => {
  // Auto eligibility is a provider/model question, not a project question: a chat with no project
  // (a general chat) is available on exactly the same terms as a project chat. See decision
  // auto-mode-tool-approval — the reasons here mirror the ones the providers themselves enumerate.
  it('is available whenever the account and model support it', () => {
    expect(getAutoModeUnavailableReason(SUPPORTED)).toBe('');
    expect(
      getAutoModeUnavailableReason({
        ...SUPPORTED,
        accountType: 'codex',
        selectedModelId: 'gpt-5-codex',
      }),
    ).toBe('');
  });

  // Order is the contract: an unresolved account must not be reported as an unsupported one, or a
  // user sees a permanent-sounding refusal during a transient check.
  it('reports the earliest blocking reason, not the most specific one', () => {
    const unresolvedAndUnsupported = {
      accountResolved: false,
      isAuthenticated: false,
      accountType: 'claude-code',
      selectedModelId: 'haiku',
    };
    expect(getAutoModeUnavailableReason(unresolvedAndUnsupported)).toBe(
      'Checking whether Auto Mode is available.',
    );
    expect(
      getAutoModeUnavailableReason({ ...unresolvedAndUnsupported, accountResolved: true }),
    ).toBe('Connect an account to use Auto Mode.');
  });

  it.each([
    ['a signed-out account', { isAuthenticated: false }, 'Connect an account to use Auto Mode.'],
    ['no account row yet', { isAuthenticated: undefined }, 'Connect an account to use Auto Mode.'],
    [
      'Claude Haiku',
      { selectedModelId: 'haiku' },
      'The selected provider or model does not support Auto Mode.',
    ],
    [
      'an unknown account type',
      { accountType: undefined },
      'The selected provider or model does not support Auto Mode.',
    ],
  ])('refuses %s', (_case, overrides, expected) => {
    expect(getAutoModeUnavailableReason({ ...SUPPORTED, ...overrides })).toBe(expected);
  });
});
