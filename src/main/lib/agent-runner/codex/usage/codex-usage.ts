import {
  type CodexAccountCatalog,
  type CodexAccountTiers,
  isCodexModelUnavailable,
} from '../../../../../shared/lib/codex-cli-models';
import type { RateLimitSnapshot, RateLimitWindow } from '../../../../../shared/types/rate-limit';
import { createPlanUsageCache, planUsageClock } from '../../../provider/plan-usage-cache';
import { captureMainException } from '../../../sentry/init';
import { CodexAppServerClient, withTimeout } from '../app-server-client';
import { resolveCodexBinary } from '../codex-binary';

const REQUEST_TIMEOUT_MS = 10_000;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;
/** An unknown catalog hides the paid speeds, so a read without it retries well inside the TTL. */
const FAILURE_RETRY_MS = 30_000;

type CodexWindow = {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
} | null;

type CodexLimitSnapshot = {
  limitId?: string | null;
  planType?: string | null;
  primary?: CodexWindow;
  secondary?: CodexWindow;
};

/** `account/read` (codex-rs app-server-protocol v2/account.rs). */
export type CodexAccountResponse = {
  account: { type: 'chatgpt'; email: string; planType: string } | { type: 'apiKey' } | null;
};

/** `account/rateLimits/read`: `usedPercent` is 0–100, durations are minutes, resets are epoch s. */
export type CodexRateLimitsResponse = {
  rateLimits: CodexLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexLimitSnapshot> | null;
};

/** `model/list` (codex-rs app-server-protocol v2/model.rs): the signed-in account's own catalog. */
export type CodexModelListResponse = {
  data: {
    model: string;
    serviceTiers?: { id: string }[] | null;
    isDefault?: boolean | null;
    hidden?: boolean | null;
  }[];
};

/** A Codex read: plan usage plus the models and paid speeds the same login can use. */
export type CodexUsageSnapshot = RateLimitSnapshot & { catalog: CodexAccountCatalog | null };

/** Codex's tier ids, as Frink names the speed. */
const SPEED_BY_TIER_ID = new Map<string, CodexAccountTiers[string][number]>([
  ['priority', 'fast'],
  ['ultrafast', 'ultrafast'],
]);

/** Each listed model's paid speeds (an unknown tier id is left out) and the account's default. */
export function codexAccountCatalog({ data }: CodexModelListResponse): CodexAccountCatalog {
  return {
    tiers: Object.fromEntries(
      data.map(({ model, serviceTiers }) => [
        model,
        (serviceTiers ?? []).flatMap(({ id }) => SPEED_BY_TIER_ID.get(id) ?? []),
      ]),
    ),
    defaultSlug: data.find((m) => m.isDefault && !m.hidden)?.model ?? null,
  };
}

/** Windows are keyed by length, not position: a Pro Lite plan's `primary` is its weekly window. */
function windowKey(mins: number): string {
  if (mins >= MONTH_MINS) return 'monthly';
  if (mins >= WEEK_MINS) return 'seven_day';
  return 'five_hour';
}

function isReported(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function toWindow(usedPercent: number, resetsAtSecs: number | null | undefined): RateLimitWindow {
  return {
    utilization: Math.min(100, Math.max(0, usedPercent)),
    resetsAt: resetsAtSecs ? resetsAtSecs * 1000 : null,
  };
}

/** Each reported window keyed by its length. The bundled Codex always sends a length; a window
 * without one, or without a numeric usage, is skipped rather than guessed. */
function keyedWindows(snapshot: CodexLimitSnapshot): Array<[string, RateLimitWindow]> {
  return [snapshot.primary, snapshot.secondary].flatMap((win): Array<[string, RateLimitWindow]> =>
    win && isReported(win.usedPercent) && isReported(win.windowDurationMins)
      ? [[windowKey(win.windowDurationMins), toWindow(win.usedPercent, win.resetsAt)]]
      : [],
  );
}

/** The main Codex allowance's windows; other limit ids (per-model buckets) are left out. */
function codexWindows(snapshot: CodexLimitSnapshot | undefined): RateLimitSnapshot['windows'] {
  if (!snapshot || (snapshot.limitId ?? 'codex') !== 'codex') return {};
  const windows = new Map<string, RateLimitWindow>();
  for (const [key, next] of keyedWindows(snapshot)) {
    // Two positions of the same length: the fuller one is the limit that binds.
    if ((windows.get(key)?.utilization ?? -1) < next.utilization) windows.set(key, next);
  }
  return Object.fromEntries(windows);
}

/** One Codex read as the whole snapshot for the login it came from. */
export function codexUsageToSnapshot(
  account: CodexAccountResponse['account'],
  limits: CodexRateLimitsResponse | null,
  now: number,
): RateLimitSnapshot {
  const chatgpt = account?.type === 'chatgpt' ? account : null;
  return {
    windows: codexWindows(limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits),
    subscriptionType: chatgpt?.planType ?? null,
    email: chatgpt?.email ?? null,
    available: chatgpt !== null,
    updatedAt: now,
  };
}

/** The two reads a usage probe makes, over a process it owns. */
type UsageClient = {
  start(): Promise<void>;
  readAccount(): Promise<CodexAccountResponse>;
  readRateLimits(): Promise<CodexRateLimitsResponse>;
  readModels(): Promise<CodexModelListResponse>;
  disposeAndWait(): Promise<void>;
};

function newUsageClient(): UsageClient {
  const binary = resolveCodexBinary();
  if (!binary) throw new Error('Bundled Codex binary is missing');
  const client = new CodexAppServerClient({
    binary,
    clientInfo: { name: 'frink-usage', version: '1' },
  });
  return {
    start: async () => {
      await client.start();
    },
    readAccount: () => client.sendRequest<CodexAccountResponse>('account/read', {}),
    readRateLimits: () => client.sendRequest<CodexRateLimitsResponse>('account/rateLimits/read'),
    readModels: () =>
      client.sendRequest<CodexModelListResponse>('model/list', { includeHidden: true }),
    disposeAndWait: () => client.disposeAndWait(),
  };
}

/** Read the active Codex login's limits and model catalog from a short-lived app-server. No thread is
 * started, so no session is written; the process is always shut down. */
export async function probeCodexUsage(
  client: UsageClient = newUsageClient(),
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<CodexUsageSnapshot> {
  try {
    await client.start();
    const { account } = await withTimeout(
      client.readAccount(),
      timeoutMs,
      'Codex did not answer account/read',
    );
    const limits =
      account?.type === 'chatgpt'
        ? await withTimeout(
            client.readRateLimits(),
            timeoutMs,
            'Codex did not answer account/rateLimits/read',
          )
        : null;
    // A failed model/list leaves the catalog unknown (static list, no paid speed), never the usage.
    let catalog: CodexAccountCatalog | null = null;
    try {
      catalog = codexAccountCatalog(
        await withTimeout(client.readModels(), timeoutMs, 'Codex did not answer model/list'),
      );
    } catch (err) {
      captureMainException(err, { surface: 'usage-codex-speed-tiers' });
    }
    return { ...codexUsageToSnapshot(account, limits, planUsageClock.now()), catalog };
  } finally {
    await client.disposeAndWait().catch(() => {});
  }
}

/** Injection seam for tests; production keeps the default. */
export const codexUsageDeps = { probe: (): Promise<CodexUsageSnapshot> => probeCodexUsage() };

/** Codex plan usage and model catalog. Unkeyed: the login is only known from the read itself, so
 * a login switch shows within the TTL. */
export const codexPlanUsage = createPlanUsageCache<void, CodexUsageSnapshot>(
  () => codexUsageDeps.probe(),
  'usage-codex-rate-limit-pull',
  { afterMs: FAILURE_RETRY_MS, incomplete: (snapshot) => snapshot.catalog === null },
);

async function readCatalog(): Promise<CodexAccountCatalog | null> {
  return (await codexPlanUsage.get())?.catalog ?? null;
}

/** The catalog a chosen Codex model is checked against: the cached read (or the first one). A model
 *  it lacks is re-checked against a fresh read, so a login switch is never refused on the old list. */
export async function codexCatalogForModel(
  pickerId: string | undefined,
): Promise<CodexAccountCatalog | null> {
  const cached = await readCatalog();
  if (!isCodexModelUnavailable(pickerId, cached)) return cached;
  codexPlanUsage.reset();
  return readCatalog();
}
