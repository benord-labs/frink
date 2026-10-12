import type { RateLimitSnapshot } from '../../../shared/types/rate-limit';
import { captureMainException } from '../sentry/init';

/** One probe per window, successful or not — the Usage tab refetches every minute. */
const PLAN_USAGE_TTL_MS = 5 * 60_000;

/** Injection seam for tests; production keeps the default. */
export const planUsageClock = { now: (): number => Date.now() };

/** The latest read for one login. A new login gets a new entry, so an older login's probe
 * finishing late writes only to its own, discarded entry. */
type Entry<S> = {
  login: string | null;
  at: number;
  snapshot: S | null;
  pull: Promise<void>;
  inFlight: boolean;
};

type PlanUsageProbe<C, S> = (credential: C, login: string | null) => Promise<S>;

/** Re-read after `afterMs` instead of the TTL when the probe fails or `incomplete` says so. */
type RetrySoon<S> = { afterMs: number; incomplete: (snapshot: S) => boolean };

/** Plan usage read by `probe` at most once per TTL (sooner per `retrySoon`), callers sharing one
 * read. A stale read returns at once; a `login` change waits for its own read. */
export function createPlanUsageCache<C, S extends RateLimitSnapshot = RateLimitSnapshot>(
  probe: PlanUsageProbe<C, S>,
  sentrySurface: string,
  retrySoon?: RetrySoon<S>,
) {
  let current: Entry<S> | null = null;

  function scheduleRetrySoon(entry: Entry<S>): void {
    if (retrySoon) entry.at = planUsageClock.now() - PLAN_USAGE_TTL_MS + retrySoon.afterMs;
  }

  function startPull(entry: Entry<S>, credential: C): void {
    entry.inFlight = true;
    entry.pull = probe(credential, entry.login)
      .then((snapshot) => {
        entry.snapshot = snapshot;
        if (retrySoon?.incomplete(snapshot)) scheduleRetrySoon(entry);
      })
      .catch((err) => {
        captureMainException(err, { surface: sentrySurface });
        scheduleRetrySoon(entry);
      })
      .finally(() => {
        entry.inFlight = false;
      });
  }

  return {
    async get(credential: C, login: string | null = null): Promise<S | null> {
      const now = planUsageClock.now();
      if (current === null || current.login !== login) {
        current = { login, at: now, snapshot: null, pull: Promise.resolve(), inFlight: false };
        startPull(current, credential);
      } else if (!current.inFlight && now - current.at >= PLAN_USAGE_TTL_MS) {
        current.at = now;
        startPull(current, credential);
      }
      const entry = current;
      if (!entry.snapshot) await entry.pull;
      return entry.snapshot;
    },
    /** Forget the cached read, so the next `get` probes again (an account change, or between tests). */
    reset(): void {
      current = null;
    },
  };
}
