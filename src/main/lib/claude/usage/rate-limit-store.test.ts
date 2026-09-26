import { describe, expect, it } from 'vitest';
import { usageToSnapshot } from './rate-limit-store';

const NOW = 1_700_000_000_000; // fixed epoch ms

describe('usageToSnapshot', () => {
  it('records unavailability and no windows for an API-key session', () => {
    const snap = usageToSnapshot(
      { subscription_type: null, rate_limits_available: false, rate_limits: null },
      NOW,
      null,
    );
    expect(snap).toEqual({
      windows: {},
      subscriptionType: null,
      email: null,
      available: false,
      updatedAt: NOW,
    });
  });

  it('ignores windows the CLI sends when it rules plan limits unavailable', () => {
    const snap = usageToSnapshot(
      {
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: { five_hour: { utilization: 40, resets_at: null } },
      },
      NOW,
      null,
    );
    expect(snap.windows).toEqual({});
  });

  it('records the login the read belongs to', () => {
    const snap = usageToSnapshot(
      { subscription_type: 'max', rate_limits_available: true, rate_limits: {} },
      NOW,
      'me@work.com',
    );
    expect(snap.email).toBe('me@work.com');
  });

  it('populates windows and subscription type, skipping a null utilization', () => {
    const snap = usageToSnapshot(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12, resets_at: '2026-08-03T18:00:00Z' },
          seven_day: { utilization: null, resets_at: null },
          seven_day_opus: null,
        },
      },
      NOW,
      null,
    );
    expect(snap.available).toBe(true);
    expect(snap.subscriptionType).toBe('max');
    expect(snap.windows).toEqual({
      five_hour: {
        utilization: 12,
        resetsAt: Date.parse('2026-08-03T18:00:00Z'),
      },
    });
  });

  it('maps every rolling window from a full SDK response and clamps to 0–100', () => {
    const win = (u: number) => ({ utilization: u, resets_at: null });
    const snap = usageToSnapshot(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: win(-5),
          seven_day: win(20),
          seven_day_opus: win(30),
          seven_day_sonnet: win(140),
          seven_day_oauth_apps: win(0),
        },
      },
      NOW,
      null,
    );
    expect(Object.keys(snap.windows).sort()).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_oauth_apps',
      'seven_day_opus',
      'seven_day_sonnet',
    ]);
    expect(snap.windows.five_hour?.utilization).toBe(0);
    expect(snap.windows.seven_day_sonnet?.utilization).toBe(100);
    expect(snap.windows.seven_day_oauth_apps?.utilization).toBe(0);
  });

  it('adds a weekly window per model-scoped entry', () => {
    const snap = usageToSnapshot(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          model_scoped: [
            { display_name: 'Fable', utilization: 3, resets_at: '2026-09-26T05:59:59Z' },
            { display_name: 'Unused', utilization: null, resets_at: null },
          ],
        },
      },
      NOW,
      null,
    );
    expect(snap.windows).toEqual({
      'model_scoped:Fable': {
        utilization: 3,
        resetsAt: Date.parse('2026-09-26T05:59:59Z'),
      },
    });
  });

  it('skips a window whose utilization is omitted', () => {
    const snap = usageToSnapshot(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { resets_at: null },
          model_scoped: [{ display_name: 'Fable', resets_at: null }],
        },
      },
      NOW,
      null,
    );
    expect(snap.windows).toEqual({});
  });

  it('treats an unparseable reset time as unknown', () => {
    const snap = usageToSnapshot(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 1, resets_at: 'soon' }, model_scoped: null },
      },
      NOW,
      null,
    );
    expect(snap.windows.five_hour?.resetsAt).toBeNull();
  });
});
