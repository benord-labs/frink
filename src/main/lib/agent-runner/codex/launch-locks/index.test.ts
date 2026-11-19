import { describe, expect, it, vi } from 'vitest';
import { buildSpawnArgs } from '../spawn-args';
import {
  CodexSettingsOverriddenError,
  CodexSettingsUncheckedError,
  launchLocks,
  verifyLaunchLocks,
} from './index';

const ARGS = buildSpawnArgs();
const LOCKED_FEATURES = launchLocks(ARGS).features;

type Feature = { name: string; enabled: boolean };
const cleanFeatures = (): Feature[] => [
  ...LOCKED_FEATURES.map((name) => ({ name, enabled: false })),
  { name: 'shell_tool', enabled: true },
];
type Config = { agents: { enabled: boolean }; shell_environment_policy: object };
const cleanConfig = (): Config => ({
  agents: { enabled: false },
  shell_environment_policy: { ignore_default_excludes: false },
});

/** A Codex peer answering the two reads; each `features` entry is one page. */
function codex(features: Feature[][] = [cleanFeatures()], config: Config = cleanConfig()) {
  const sendRequest = vi.fn(async (method: string, params: { cursor?: string }) => {
    if (method === 'config/read') return { config };
    const index = Number(params.cursor ?? 0);
    const nextCursor = index + 1 < features.length ? String(index + 1) : null;
    return { data: features[index], nextCursor };
  });
  return { sendRequest };
}

function withFeature(name: string, enabled: boolean): Feature[] {
  return cleanFeatures().map((feature) => (feature.name === name ? { name, enabled } : feature));
}

describe('launchLocks', () => {
  it('takes every disabled feature and only the locked config keys, last value winning', () => {
    const locks = launchLocks(
      buildSpawnArgs(['--config', 'mcp_servers.frink.url="u"', '--config', 'agents.enabled=true']),
    );
    expect(locks.features).toContain('multi_agent_v2');
    expect(locks.config).toEqual([
      ['agents.enabled', 'false'],
      ['shell_environment_policy.ignore_default_excludes', 'false'],
    ]);
  });
});

describe('verifyLaunchLocks', () => {
  it('passes when Codex kept every lock it was launched with', async () => {
    const peer = codex();
    await expect(verifyLaunchLocks(peer, ARGS, '/repo')).resolves.toBeUndefined();
    expect(peer.sendRequest).toHaveBeenCalledWith('config/read', { cwd: '/repo' });
  });

  it('refuses in plain words when a managed pin turns multi_agent_v2 back on', async () => {
    const refusal = verifyLaunchLocks(codex([withFeature('multi_agent_v2', true)]), ARGS);
    await expect(refusal).rejects.toBeInstanceOf(CodexSettingsOverriddenError);
    await expect(refusal).rejects.toThrow(
      /turn on helper agents, which Frink can't check before they act.*`multi_agent_v2`/,
    );
  });

  it('reads every page of features before deciding', async () => {
    const firstPage = cleanFeatures().filter((feature) => feature.name !== 'computer_use');
    const pages = [firstPage, [{ name: 'computer_use', enabled: true }]];
    await expect(verifyLaunchLocks(codex(pages), ARGS)).rejects.toThrow('computer control');
  });

  it('refuses when managed config switches agents back on', async () => {
    const config = { ...cleanConfig(), agents: { enabled: true } };
    await expect(verifyLaunchLocks(codex(undefined, config), ARGS)).rejects.toThrow(
      '`agents.enabled`',
    );
  });

  it('fails closed when Codex does not report a locked feature', async () => {
    const missing = cleanFeatures().filter((feature) => feature.name !== 'multi_agent');
    await expect(verifyLaunchLocks(codex([missing]), ARGS)).rejects.toBeInstanceOf(
      CodexSettingsUncheckedError,
    );
  });

  it('fails closed with a retry message when a read fails', async () => {
    const peer = { sendRequest: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(verifyLaunchLocks(peer, ARGS)).rejects.toThrow('Send your message again');
  });

  it('reads nothing when the launch set no locks', async () => {
    const peer = codex();
    await verifyLaunchLocks(peer, ['--config', 'model="m"']);
    expect(peer.sendRequest).not.toHaveBeenCalled();
  });
});
