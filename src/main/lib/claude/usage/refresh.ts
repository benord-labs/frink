import type { CredentialResult } from '../../credentials';
import { createPlanUsageCache, planUsageClock } from '../../provider/plan-usage-cache';
import { usageToSnapshot } from './rate-limit-store';
import { probeClaudeUsage } from './usage-probe';

/** Injection seam for tests; production keeps the default. */
export const claudeUsageDeps = { probe: probeClaudeUsage };

/** Claude plan usage, keyed by the login's email: an account switcher can swap the keychain login
 * under one credential row. */
export const claudePlanUsage = createPlanUsageCache<Pick<CredentialResult, 'token' | 'isApiKey'>>(
  async (credential, login) =>
    usageToSnapshot(await claudeUsageDeps.probe(credential), planUsageClock.now(), login),
  'usage-rate-limit-pull',
);
