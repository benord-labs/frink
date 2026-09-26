import { describe, expect, it, vi } from 'vitest';
import { type CodexAccountResponse, codexUsageToSnapshot, probeCodexUsage } from './codex-usage';

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

describe('probeCodexUsage', () => {
  const weekly = { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } } };

  function fakeClient(account: CodexAccountResponse['account']) {
    return {
      start: vi.fn(async () => {}),
      readAccount: vi.fn(async () => ({ account })),
      readRateLimits: vi.fn(async () => weekly),
      disposeAndWait: vi.fn(async () => {}),
    };
  }

  it('reads identity and limits from one process, then shuts it down', async () => {
    const client = fakeClient(chatgpt);
    const snap = await probeCodexUsage(client);
    expect(snap).toMatchObject({
      email: 'me@home.com',
      windows: { five_hour: { utilization: 5 } },
    });
    expect(client.disposeAndWait).toHaveBeenCalledTimes(1);
  });

  it('never asks an API-key login for plan limits', async () => {
    const client = fakeClient({ type: 'apiKey' });
    await probeCodexUsage(client);
    expect(client.readRateLimits).not.toHaveBeenCalled();
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
