import type { RateLimitSnapshot } from '../../../../shared/types/rate-limit';
import { codexPlanUsage } from '../../agent-runner/codex/usage';
import { claudePlanUsage } from '../../claude/usage';
import { getDefaultCredentialForType, isResolvedCredential } from '../../credentials';
import { readClaudeUserConfig } from '../../credentials/detect';
import { publicProcedureRaw, router } from '../index';

/** Empty snapshot for the unavailable / pre-first-data states. */
function emptyUsage(available: boolean): RateLimitSnapshot {
  return { windows: {}, subscriptionType: null, email: null, available, updatedAt: 0 };
}

/**
 * Subscription plan-usage ("how much of my plan is left") for Settings → Usage, one query per
 * provider so a slow Codex read never holds up the Claude bars. Each is read by an isolated probe.
 *
 * Uses the RAW procedure deliberately: the default output transform camel-cases object keys, which
 * would rewrite the snake_case window keys (`five_hour`, `seven_day`, …) the renderer indexes by.
 */
export const usageRouter = router({
  getRateLimits: publicProcedureRaw.query(async (): Promise<RateLimitSnapshot> => {
    // Gate on the Claude account, never the cross-provider default, and rule an API key out without
    // spawning; the probe's `rate_limits_available` decides the rest.
    const cred = await getDefaultCredentialForType('claude-code');
    if (!isResolvedCredential(cred) || cred.isApiKey) {
      return emptyUsage(false);
    }
    const login = readClaudeUserConfig().email ?? null;
    return (await claudePlanUsage.get(cred, login)) ?? emptyUsage(true);
  }),

  getCodexUsage: publicProcedureRaw.query(async (): Promise<RateLimitSnapshot> => {
    // No Codex account connected: spawn nothing. Otherwise the probe's account type decides.
    if (!isResolvedCredential(await getDefaultCredentialForType('codex'))) {
      return emptyUsage(false);
    }
    return (await codexPlanUsage.get()) ?? emptyUsage(true);
  }),
});
