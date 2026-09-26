import type { RateLimitSnapshot } from '../../../shared/types/rate-limit';
import { captureMainException } from '../sentry/init';

/** One probe per window, successful or not — the Usage tab refetches every minute. */
const PLAN_USAGE_TTL_MS = 5 * 60_000;

/** Injection seam for tests; production keeps the default. */
export const planUsageClock = { now: (): number => Date.now() };

/** The latest read for one login. A new login gets a new entry, so an older login's probe
 * finishing late writes only to its own, discarded entry. */
type Entry = {
  login: string | null;
  at: number;
  snapshot: RateLimitSnapshot | null;
  pull: Promise<void>;
  inFlight: boolean;
};

type PlanUsageProbe<C> = (credential: C, login: string | null) => Promise<RateLimitSnapshot>;

/** Plan usage read by `probe` at most once per TTL (failures included), concurrent callers sharing
 * one read. A stale read returns at once; a `login` change waits for its own read. */
export function createPlanUsageCache<C>(probe: PlanUsageProbe<C>, sentrySurface: string) {
  let current: Entry | null = null;

  function startPull(entry: Entry, credential: C): void {
    entry.inFlight = true;
    entry.pull = probe(credential, entry.login)
      .then((snapshot) => {
        entry.snapshot = snapshot;
      })
      .catch((err) => captureMainException(err, { surface: sentrySurface }))
      .finally(() => {
        entry.inFlight = false;
      });
  }

  return {
    async get(credential: C, login: string | null = null): Promise<RateLimitSnapshot | null> {
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
    /** Test-only: forget the cached read between cases. */
    reset(): void {
      current = null;
    },
  };
}
