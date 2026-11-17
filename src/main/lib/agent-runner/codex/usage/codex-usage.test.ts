import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planUsageClock } from '../../../provider/plan-usage-cache';
import {
  type CodexAccountResponse,
  type CodexUsageSnapshot,
  codexAccountCatalog,
  codexCatalogForModel,
  codexPlanUsage,
  codexUsageDeps,
  codexUsageToSnapshot,
  probeCodexUsage,
} from './codex-usage';

const NOW = 1_700_000_000_000;
const chatgpt = { type: 'chatgpt' as const, email: 'me@home.com', planType: 'plus' };

describe('codexUsageToSnapshot', () => {
  it('keys windows by length, so a weekly-only plan shows one Weekly row', () => {
    const snap = codexUsageToSnapshot(
      { ...chatgpt, planType: 'prolite' },
      {
        rateLimits: { limitId: 'codex' },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 97, windowDurationMins: 10_080, resetsAt: 1_790_597_270 },
            secondary: null,
          },
        },
      },
      NOW,
    );
    expect(snap).toEqual({
      windows: { seven_day: { utilization: 97, resetsAt: 1_790_597_270_000 } },
      subscriptionType: 'prolite',
      email: 'me@home.com',
      available: true,
      updatedAt: NOW,
    });
  });

  it('keeps the fuller window when both positions report the same length', () => {
    const snap = codexUsageToSnapshot(
      chatgpt,
      {
        rateLimits: {
          primary: { usedPercent: 80, windowDurationMins: 10_080 },
          secondary: { usedPercent: 30, windowDurationMins: 10_080 },
        },
      },
      NOW,
    );
    expect(snap.windows).toEqual({ seven_day: { utilization: 80, resetsAt: null } });
  });

  it('skips a window that reports no usage instead of drawing a NaN row', () => {
    const snap = codexUsageToSnapshot(
      chatgpt,
      {
        rateLimits: {
          primary: { usedPercent: null, windowDurationMins: 300 },
          secondary: { usedPercent: 12, windowDurationMins: 10_080 },
        },
      },
      NOW,
    );
    expect(snap.windows).toEqual({ seven_day: { utilization: 12, resetsAt: null } });
  });

  it('keys a month-long allowance as monthly', () => {
    const snap = codexUsageToSnapshot(
      { ...chatgpt, planType: 'free' },
      { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 43_200 } } },
      NOW,
    );
    expect(Object.keys(snap.windows)).toEqual(['monthly']);
  });

  it('skips a window with no length rather than guessing one', () => {
    const snap = codexUsageToSnapshot(
      { ...chatgpt, planType: 'prolite' },
      { rateLimits: { primary: { usedPercent: 97 } } },
      NOW,
    );
    expect(snap.windows).toEqual({});
  });

  it('shows only the main Codex allowance, never another limit id', () => {
    const snap = codexUsageToSnapshot(
      chatgpt,
      {
        rateLimits: {
          limitId: 'base_model_inference',
          primary: { usedPercent: 50, windowDurationMins: 300 },
        },
      },
      NOW,
    );
    expect(snap.windows).toEqual({});
  });

  it('marks an API-key login unavailable', () => {
    expect(codexUsageToSnapshot({ type: 'apiKey' }, null, NOW)).toMatchObject({
      available: false,
      email: null,
      windows: {},
    });
  });
});

describe('codexAccountCatalog', () => {
  it("maps each model's Codex tier ids to Frink's speeds, leaving unknown ids out", () => {
    expect(
      codexAccountCatalog({
        data: [
          { model: 'gpt-6-astra', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
          { model: 'gpt-5.5', serviceTiers: [{ id: 'priority' }, { id: 'flex' }] },
          { model: 'gpt-6-luna', serviceTiers: [] },
          { model: 'gpt-5.4-mini' },
        ],
      }),
    ).toMatchObject({
      tiers: {
        'gpt-6-astra': ['fast', 'ultrafast'],
        'gpt-5.5': ['fast'],
        'gpt-6-luna': [],
        'gpt-5.4-mini': [],
      },
    });
  });

  it("takes the account's default from its listed, non-hidden models", () => {
    const catalog = codexAccountCatalog({
      data: [
        { model: 'codex-auto-review', isDefault: true, hidden: true },
        { model: 'gpt-5.5' },
        { model: 'gpt-6-luna', isDefault: true },
      ],
    });
    expect(catalog.defaultSlug).toBe('gpt-6-luna');
  });

  it('gives an empty catalog no tiers and no default', () => {
    expect(codexAccountCatalog({ data: [] })).toEqual({ tiers: {}, defaultSlug: null });
  });
});

describe('probeCodexUsage', () => {
  const weekly = { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } } };

  function fakeClient(account: CodexAccountResponse['account']) {
    return {
      start: vi.fn(async () => {}),
      readAccount: vi.fn(async () => ({ account })),
      readRateLimits: vi.fn(async () => weekly),
      readModels: vi.fn(async () => ({
        data: [{ model: 'gpt-6-astra', serviceTiers: [{ id: 'priority' }] }],
      })),
      disposeAndWait: vi.fn(async () => {}),
    };
  }

  it('reads identity, limits and the model catalog from one process, then shuts it down', async () => {
    const client = fakeClient(chatgpt);
    const snap = await probeCodexUsage(client);
    expect(snap).toMatchObject({
      email: 'me@home.com',
      windows: { five_hour: { utilization: 5 } },
      catalog: { tiers: { 'gpt-6-astra': ['fast'] } },
    });
    expect(client.disposeAndWait).toHaveBeenCalledTimes(1);
  });

  it('never asks an API-key login for plan limits, but still reads its model catalog', async () => {
    const client = fakeClient({ type: 'apiKey' });
    expect((await probeCodexUsage(client)).catalog?.tiers).toEqual({ 'gpt-6-astra': ['fast'] });
    expect(client.readRateLimits).not.toHaveBeenCalled();
  });

  it('keeps the usage when only model/list fails, leaving the catalog unknown', async () => {
    const client = {
      ...fakeClient(chatgpt),
      readModels: vi.fn(async () => {
        throw new Error('model/list failed');
      }),
    };
    const snap = await probeCodexUsage(client);
    expect(snap).toMatchObject({ windows: { five_hour: { utilization: 5 } }, catalog: null });
  });

  it('gives up on a request Codex never answers and still shuts the process down', async () => {
    const client = {
      ...fakeClient(chatgpt),
      readAccount: vi.fn(() => new Promise<never>(() => {})),
    };
    await expect(probeCodexUsage(client, 5)).rejects.toThrow('Codex did not answer account/read');
    expect(client.disposeAndWait).toHaveBeenCalledTimes(1);
  });
});

describe('codexCatalogForModel', () => {
  const catalog = { tiers: { 'gpt-6-luna': [] }, defaultSlug: 'gpt-6-luna' };
  const snapshot: CodexUsageSnapshot = {
    windows: {},
    subscriptionType: 'free',
    email: null,
    available: true,
    updatedAt: 0,
    catalog,
  };
  const probe = vi.fn(async () => snapshot);

  beforeEach(() => {
    probe.mockClear();
    codexPlanUsage.reset();
    codexUsageDeps.probe = probe;
  });

  it('uses a cached read without probing again', async () => {
    await codexPlanUsage.get();
    expect(await codexCatalogForModel(undefined)).toEqual(catalog);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-reads before refusing, so a switch to a login that has the model is not refused', async () => {
    const plus = { tiers: { 'gpt-6-astra': [], 'gpt-6-luna': [] }, defaultSlug: 'gpt-6-astra' };
    await codexPlanUsage.get(); // the free login's list, cached
    probe.mockResolvedValueOnce({ ...snapshot, subscriptionType: 'plus', catalog: plus });

    expect(await codexCatalogForModel('codex-gpt-6-astra-medium')).toEqual(plus);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('costs no extra read for a model the cached list has', async () => {
    await codexPlanUsage.get();
    expect(await codexCatalogForModel('codex-gpt-6-luna-medium')).toEqual(catalog);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reads the catalog on a cold cache, so a first turn after launch is still checked', async () => {
    expect(await codexCatalogForModel(undefined)).toEqual(catalog);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('retries a read whose model list failed once that retry is due, with no other reader', async () => {
    const now = planUsageClock.now;
    let clock = 1_000_000;
    planUsageClock.now = () => clock;
    try {
      probe.mockResolvedValueOnce({ ...snapshot, catalog: null });
      expect(await codexCatalogForModel(undefined)).toBeNull();
      clock += 30_000;
      await codexCatalogForModel(undefined);
      expect(probe).toHaveBeenCalledTimes(2);
      await vi.waitFor(async () => expect(await codexCatalogForModel(undefined)).toEqual(catalog));
    } finally {
      planUsageClock.now = now;
    }
  });
});
