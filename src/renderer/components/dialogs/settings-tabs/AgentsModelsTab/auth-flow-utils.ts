import {
  AI_PROVIDERS,
  type AiProviderId,
  selectableProviderIds,
} from '../../../../../shared/lib/ai-providers';

export type AccountType = AiProviderId;

export type AccountAuthSelection = {
  id: string;
  label: string;
  isApiKey?: boolean;
  type?: AccountType;
  source?: string | null;
};

export function shouldUseInlineCredentialEdit(account: {
  isApiKey?: boolean;
  type?: AccountType;
}): boolean {
  return Boolean(account.isApiKey);
}

export function buildPendingReauthState(account: {
  id: string;
  label: string;
  type?: AccountType;
}) {
  return {
    accountId: account.id,
    accountLabel: account.label,
    mode: 'reauth' as const,
    returnToSettings: true,
    provider: account.type ?? 'claude-code',
  };
}

/** No label: the connect page names the account after the login it detects. */
export function buildPendingAddState(provider: AccountType) {
  return { accountLabel: '', mode: 'add' as const, returnToSettings: true, provider };
}

/** Providers this device can still sign in to or connect, in table order. One login each. */
export function signInProviders(
  accounts: Array<{ source?: string | null }>,
  flags: Parameters<typeof selectableProviderIds>[0],
  platform: string | undefined,
): AccountType[] {
  const connected = new Set(accounts.map((account) => account.source));
  return selectableProviderIds(flags, platform).filter(
    // Claude's own sign-in needs macOS or Linux.
    (id) =>
      !connected.has(AI_PROVIDERS[id].passthroughSource) &&
      !(id === 'claude-code' && platform === 'win32'),
  );
}

/** "Claude API key", then "Claude API key 2"…: account names must be unique. */
export function nextApiKeyName(labels: string[]): string {
  let name = 'Claude API key';
  for (let n = 2; labels.includes(name); n++) name = `Claude API key ${n}`;
  return name;
}
