import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsHost } from '.';

const capture = vi.fn();
const message = { workspaceId: 'chat-1', messageLength: 5, mode: 'agent' as const };
let userData: string;

const installIdFile = () => join(userData, '.install_id');
const sentEvents = () => capture.mock.calls.map(([sent]) => sent.event);
const sentIds = () => [...new Set(capture.mock.calls.map(([sent]) => sent.distinctId))];

/** Loads a fresh copy of the module, as a new app launch would, in an official build by default. */
async function launch(overrides: Partial<AnalyticsHost> = {}) {
  vi.resetModules();
  const analytics = await import('.');
  analytics.initAnalytics({
    isPackaged: true,
    userDataDir: userData,
    version: '1.2.3',
    key: 'phc_test',
    disableUsageAnalytics: undefined,
    createClient: () => ({ capture, shutdown: async () => {} }),
    ...overrides,
  });
  return analytics;
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'frink-analytics-'));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
  capture.mockClear();
});

describe('main-process analytics', () => {
  it('sends nothing before the renderer reports the saved preference', async () => {
    const analytics = await launch();

    analytics.trackMessageSent(message);
    await analytics.shutdown();

    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(installIdFile())).toBe(false);
  });

  it('sends nothing, and creates no install id, for an install that opted out', async () => {
    const analytics = await launch();

    analytics.setOptOut(true);
    analytics.trackMessageSent(message);
    await analytics.shutdown();

    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(installIdFile())).toBe(false);
  });

  it('reports the app open once, however often the preference is reported', async () => {
    const analytics = await launch();

    analytics.setOptOut(false);
    analytics.setOptOut(false);

    expect(sentEvents()).toEqual(['desktop_opened', 'first_launch']);
  });

  it('reports the app open when a user opts back in', async () => {
    const analytics = await launch();

    analytics.setOptOut(true);
    analytics.setOptOut(false);

    expect(sentEvents()).toEqual(['desktop_opened', 'first_launch']);
  });

  it('keeps one id for the install across launches and events', async () => {
    const firstLaunch = await launch();
    firstLaunch.setOptOut(false);
    await firstLaunch.shutdown();
    const secondLaunch = await launch();
    secondLaunch.setOptOut(false);
    secondLaunch.trackMessageSent(message);

    expect(sentEvents()).toEqual([
      'desktop_opened',
      'first_launch',
      'desktop_opened',
      'message_sent',
    ]);
    expect(sentIds()).toEqual([readFileSync(installIdFile(), 'utf8')]);
    expect(capture.mock.calls.every(([sent]) => sent.disableGeoip === true)).toBe(true);
    expect(capture.mock.calls[2][0].properties.first_launch).toBe(false);
    expect(capture.mock.calls[3][0].properties).toMatchObject({
      app_version: '1.2.3',
      workspace_id: 'chat-1',
      message_length: 5,
      mode: 'agent',
    });
  });

  it('sends only the published properties with each event', async () => {
    const analytics = await launch();
    analytics.setOptOut(false);
    capture.mockClear();

    analytics.trackProjectOpened({ id: 'project-1', hasGitRemote: true });
    analytics.trackWorkspaceCreated({ id: 'chat-1', projectId: 'project-1', useWorktree: true });
    analytics.trackWorkspaceArchived('chat-1');
    analytics.trackWorkspaceDeleted('chat-1');
    analytics.trackPRCreated({ workspaceId: 'chat-1', prNumber: 7 });
    analytics.trackAccountConnected({ provider: 'codex', kind: 'passthrough', reconnect: false });
    analytics.trackAccountConnectFailed({ provider: 'cursor', reason: 'not_signed_in' });

    const sentWithEveryEvent = [
      'source',
      'app_version',
      'platform',
      'arch',
      'electron_version',
      'node_version',
    ];
    const sent = capture.mock.calls.map(([{ event, properties }]) => [
      event,
      Object.keys(properties).filter((name) => !sentWithEveryEvent.includes(name)),
    ]);
    expect(sent).toEqual([
      ['project_opened', ['project_id', 'has_git_remote']],
      ['workspace_created', ['workspace_id', 'project_id', 'use_worktree']],
      ['workspace_archived', ['workspace_id']],
      ['workspace_deleted', ['workspace_id']],
      ['pr_created', ['workspace_id', 'pr_number']],
      ['account_connected', ['provider', 'kind', 'reconnect']],
      ['account_connect_failed', ['provider', 'reason']],
    ]);
  });

  it('counts each account connect failure once per launch, from the first report after opt-in', async () => {
    const analytics = await launch();
    const notSignedIn = { provider: 'codex', reason: 'not_signed_in' } as const;

    analytics.setOptOut(true);
    analytics.trackAccountConnectFailed(notSignedIn);
    analytics.setOptOut(false);
    capture.mockClear();
    analytics.trackAccountConnectFailed(notSignedIn);
    analytics.trackAccountConnectFailed(notSignedIn);
    analytics.trackDetectionFailure('codex', 'not_signed_in');
    analytics.trackDetectionFailure('codex', 'cli_missing');
    // Keyed by provider too: a second agent with the same reason is a separate failure
    analytics.trackDetectionFailure('claude-code', 'not_signed_in');
    analytics.trackDetectionFailure('claude-code', 'unsupported');
    analytics.trackDetectionFailure('claude-code', undefined);

    expect(capture.mock.calls.map(([{ properties }]) => properties.reason)).toEqual([
      'not_signed_in',
      'cli_missing',
      'not_signed_in',
    ]);
  });

  it('counts a connect, marks a reconnect, and counts a thrown connect as unknown', async () => {
    const analytics = await launch();
    analytics.setOptOut(false);
    capture.mockClear();
    const account = { provider: 'opencode', kind: 'passthrough' } as const;

    await analytics.trackAccountConnect(account, () => ({ status: 'created' as const }));
    await analytics.trackAccountConnect(account, async () => ({ status: 'updated' as const }));
    await expect(
      analytics.trackAccountConnect(account, () => {
        throw new Error('An account named "Work" already exists.');
      }),
    ).rejects.toThrow('already exists');

    expect(capture.mock.calls.map(([{ event, properties }]) => [event, properties])).toEqual([
      ['account_connected', expect.objectContaining({ ...account, reconnect: false })],
      ['account_connected', expect.objectContaining({ ...account, reconnect: true })],
      [
        'account_connect_failed',
        expect.objectContaining({ provider: 'opencode', reason: 'unknown' }),
      ],
    ]);
    expect(JSON.stringify(capture.mock.calls)).not.toContain('Work');
  });

  it('sends no account event for an install that opted out', async () => {
    const analytics = await launch();
    analytics.setOptOut(true);

    await analytics.trackAccountConnect({ provider: 'codex', kind: 'passthrough' }, () => ({
      status: 'created' as const,
    }));
    analytics.trackAccountConnectFailed({ provider: 'codex', reason: 'cli_missing' });

    expect(capture).not.toHaveBeenCalled();
  });

  it('sends nothing after shutdown', async () => {
    const analytics = await launch();
    analytics.setOptOut(false);
    capture.mockClear();

    await analytics.shutdown();
    analytics.trackMessageSent(message);

    expect(capture).not.toHaveBeenCalled();
  });

  it('sends nothing from an unpackaged build', async () => {
    const analytics = await launch({ isPackaged: false });

    analytics.setOptOut(false);
    await analytics.shutdown();

    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(installIdFile())).toBe(false);
  });

  it('sends nothing from a build with no key', async () => {
    const analytics = await launch({ key: undefined });

    analytics.setOptOut(false);

    expect(capture).not.toHaveBeenCalled();
  });

  it('sends nothing, and creates no install id, from a launch that switched usage analytics off', async () => {
    const analytics = await launch({ disableUsageAnalytics: '1' });

    analytics.setOptOut(false);
    analytics.trackMessageSent(message);
    await analytics.shutdown();

    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(installIdFile())).toBe(false);
  });

  it('keeps the saved install id through a launch that switched usage analytics off', async () => {
    const firstLaunch = await launch();
    firstLaunch.setOptOut(false);
    await firstLaunch.shutdown();
    const savedId = readFileSync(installIdFile(), 'utf8');
    const switchedOff = await launch({ disableUsageAnalytics: '1' });
    switchedOff.setOptOut(false);
    await switchedOff.shutdown();
    const nextLaunch = await launch();
    nextLaunch.setOptOut(false);

    expect(sentEvents()).toEqual(['desktop_opened', 'first_launch', 'desktop_opened']);
    expect(sentIds()).toEqual([savedId]);
    expect(readFileSync(installIdFile(), 'utf8')).toBe(savedId);
  });

  it.each(['', '0', 'false'])('sends as usual when the off switch is %j', async (value) => {
    const analytics = await launch({ disableUsageAnalytics: value });

    analytics.setOptOut(false);

    expect(sentEvents()).toEqual(['desktop_opened', 'first_launch']);
  });
});
