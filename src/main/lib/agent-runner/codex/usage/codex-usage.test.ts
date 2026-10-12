import { describe, expect, it, vi } from 'vitest';
import {
  type CodexAccountResponse,
  codexSpeedTiers,
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

describe('codexSpeedTiers', () => {
  it("maps each model's Codex tier ids to Frink's speeds, leaving unknown ids out", () => {
    expect(
      codexSpeedTiers({
        data: [
          { model: 'gpt-6-astra', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
          { model: 'gpt-5.5', serviceTiers: [{ id: 'priority' }, { id: 'flex' }] },
          { model: 'gpt-6-luna', serviceTiers: [] },
          { model: 'gpt-5.4-mini' },
        ],
      }),
    ).toEqual({
      'gpt-6-astra': ['fast', 'ultrafast'],
      'gpt-5.5': ['fast'],
      'gpt-6-luna': [],
      'gpt-5.4-mini': [],
    });
  });

  it('gives an empty catalog no tiers', () => {
    expect(codexSpeedTiers({ data: [] })).toEqual({});
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

  it('reads identity, limits and speed tiers from one process, then shuts it down', async () => {
    const client = fakeClient(chatgpt);
    const snap = await probeCodexUsage(client);
    expect(snap).toMatchObject({
      email: 'me@home.com',
      windows: { five_hour: { utilization: 5 } },
      speedTiers: { 'gpt-6-astra': ['fast'] },
    });
    expect(client.disposeAndWait).toHaveBeenCalledTimes(1);
  });

  it('never asks an API-key login for plan limits, but still reads its speed tiers', async () => {
    const client = fakeClient({ type: 'apiKey' });
    expect((await probeCodexUsage(client)).speedTiers).toEqual({ 'gpt-6-astra': ['fast'] });
    expect(client.readRateLimits).not.toHaveBeenCalled();
  });

  it('keeps the usage when only model/list fails, leaving the speed tiers unknown', async () => {
    const client = {
      ...fakeClient(chatgpt),
      readModels: vi.fn(async () => {
        throw new Error('model/list failed');
      }),
    };
    const snap = await probeCodexUsage(client);
    expect(snap).toMatchObject({ windows: { five_hour: { utilization: 5 } }, speedTiers: null });
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
