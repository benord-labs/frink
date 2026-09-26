import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the modules the router composes so we can drive each branch of its wiring.
vi.mock('../../credentials', () => ({
  getDefaultCredentialForType: vi.fn(),
  isResolvedCredential: (cred: { token?: unknown; passthrough?: boolean } | null) =>
    !!cred?.token || cred?.passthrough === true,
}));
vi.mock('../../credentials/detect', () => ({ readClaudeUserConfig: vi.fn(() => ({})) }));
vi.mock('../../sentry/init', () => ({ captureMainException: vi.fn() }));

import { codexPlanUsage, codexUsageDeps } from '../../agent-runner/codex/usage';
import { claudePlanUsage } from '../../claude/usage';
import { claudeUsageDeps } from '../../claude/usage/refresh';
import { getDefaultCredentialForType } from '../../credentials';
import { readClaudeUserConfig } from '../../credentials/detect';
import { planUsageClock } from '../../provider/plan-usage-cache';
import { captureMainException } from '../../sentry/init';
import { usageRouter } from './usage';

const caller = usageRouter.createCaller({} as never);
const asMock = <T>(fn: T) =>
  fn as unknown as {
    mockResolvedValue: (v: unknown) => void;
    mockReturnValue: (v: unknown) => void;
  };

const subscriptionCred = { token: null, passthrough: true, isApiKey: false, type: 'claude-code' };
const apiKeyCred = { token: 'sk-ant-api-xxx', isApiKey: true, type: 'claude-code' };

const usageOf = (fiveHour: number) => ({
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: fiveHour, resets_at: null } },
});
const probeSpy = vi.fn(async () => usageOf(10));
claudeUsageDeps.probe = probeSpy;
let clock = 0;
planUsageClock.now = () => clock;

const signIn = (email: string) => asMock(readClaudeUserConfig).mockReturnValue({ email });
const fiveHour = async () => (await caller.getRateLimits()).windows.five_hour?.utilization;

describe('usageRouter.getRateLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claudePlanUsage.reset();
    clock = 1_000_000;
    asMock(getDefaultCredentialForType).mockResolvedValue(subscriptionCred);
    signIn('me@work.com');
  });

  it('reports unavailable for an API-key account without probing', async () => {
    asMock(getDefaultCredentialForType).mockResolvedValue(apiKeyCred);
    const res = await caller.getRateLimits();
    expect(res.available).toBe(false);
    expect(res.windows).toEqual({});
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('reports unavailable when no Claude account resolves', async () => {
    asMock(getDefaultCredentialForType).mockResolvedValue({
      token: null,
      isApiKey: false,
      type: 'claude-code',
    });
    const res = await caller.getRateLimits();
    expect(res.available).toBe(false);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('probes on first read, so the bars load with no chat open', async () => {
    const res = await caller.getRateLimits();
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      available: true,
      subscriptionType: 'max',
      email: 'me@work.com',
      updatedAt: clock,
    });
    expect(res.windows.five_hour?.utilization).toBe(10);
  });

  it('captures a failed first probe and still degrades gracefully', async () => {
    probeSpy.mockRejectedValueOnce(new Error('probe boom'));
    const res = await caller.getRateLimits();
    expect(res).toEqual({
      windows: {},
      subscriptionType: null,
      email: null,
      available: true,
      updatedAt: 0,
    });
    expect(captureMainException).toHaveBeenCalledTimes(1);
  });

  it('shares one probe between concurrent reads', async () => {
    await Promise.all([caller.getRateLimits(), caller.getRateLimits()]);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  it('serves the cached read inside the TTL, then returns it while the next probe runs', async () => {
    await caller.getRateLimits();
    clock += 60_000;
    expect(await fiveHour()).toBe(10);
    expect(probeSpy).toHaveBeenCalledTimes(1);

    let finish = (): void => {};
    probeSpy.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(usageOf(20)))),
    );
    clock += 5 * 60_000;
    expect(await fiveHour()).toBe(10);
    expect(probeSpy).toHaveBeenCalledTimes(2);
    finish();
    await vi.waitFor(async () => expect(await fiveHour()).toBe(20));
  });

  it('never starts a second read while one is still running', async () => {
    await caller.getRateLimits();
    let finish = (): void => {};
    probeSpy.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(usageOf(20)))),
    );
    clock += 5 * 60_000;
    await caller.getRateLimits();
    clock += 5 * 60_000;
    await caller.getRateLimits();
    expect(probeSpy).toHaveBeenCalledTimes(2);
    finish();
    await vi.waitFor(async () => expect(await fiveHour()).toBe(20));
  });

  it('waits out the TTL after a failed probe instead of retrying every refetch', async () => {
    probeSpy.mockRejectedValueOnce(new Error('not logged in'));
    await caller.getRateLimits();
    clock += 60_000;
    await caller.getRateLimits();
    expect(probeSpy).toHaveBeenCalledTimes(1);
    clock += 5 * 60_000;
    await caller.getRateLimits();
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  it("never shows the previous login's bars after the login changes", async () => {
    await caller.getRateLimits();
    probeSpy.mockResolvedValueOnce(usageOf(70));
    signIn('me@home.com');
    clock += 60_000;
    expect(await fiveHour()).toBe(70);
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  it("drops a switched-away login's late probe", async () => {
    let finishOld = (): void => {};
    probeSpy.mockImplementationOnce(
      () => new Promise((resolve) => (finishOld = () => resolve(usageOf(99)))),
    );
    const old = caller.getRateLimits();
    await vi.waitFor(() => expect(probeSpy).toHaveBeenCalledTimes(1));
    signIn('me@home.com');
    expect(await fiveHour()).toBe(10);
    finishOld();
    await old;
    expect(await fiveHour()).toBe(10);
  });
});

describe('usageRouter.getCodexUsage', () => {
  const codexSnapshot = {
    windows: { seven_day: { utilization: 97, resetsAt: 1_790_597_270_000 } },
    subscriptionType: 'prolite',
    email: 'me@home.com',
    available: true,
    updatedAt: 5,
  };
  const codexProbe = vi.fn(async () => codexSnapshot);
  codexUsageDeps.probe = codexProbe;

  beforeEach(() => {
    vi.clearAllMocks();
    codexPlanUsage.reset();
  });

  it('spawns nothing when no Codex account is connected', async () => {
    asMock(getDefaultCredentialForType).mockResolvedValue({
      token: null,
      isApiKey: false,
      type: 'codex',
    });
    expect(await caller.getCodexUsage()).toMatchObject({ available: false, windows: {} });
    expect(codexProbe).not.toHaveBeenCalled();
  });

  it("returns the Codex login's windows and identity from one read", async () => {
    asMock(getDefaultCredentialForType).mockResolvedValue({
      token: null,
      passthrough: true,
      isApiKey: false,
      type: 'codex',
    });
    expect(await caller.getCodexUsage()).toEqual(codexSnapshot);
    expect(getDefaultCredentialForType).toHaveBeenCalledWith('codex');
  });
});
