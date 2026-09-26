import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as tokenCrypto from '../../credentials/token-crypto';
import * as installationsRepo from '../../db/repos/plugin-installations';
import { getByPluginId } from '../../db/repos/plugin-installations';
import {
  insertIntegration,
  insertWebhookEndpoint,
  listLocalIntegrations,
} from '../../db/repos/webhook-ingress';
import { freshDb } from '../../db/test-utils/fresh-db';
import { endpointRow } from '../../webhooks/test-utils';
import * as mcp from '../../mcp';
import * as vendorStaging from './vendor-staging';
import * as vendorStore from '../../claude/session-config-dir';
import { vendorPluginPin } from '../../../../shared/integrations/vendor-plugin-pins';
import { fakePosthogApi } from '../trigger-registrars/test-helpers';
import { grantUserToken, installMcpPlugin, setMcpPluginEnabled, uninstallMcpPlugin } from './index';

process.env.FRINK_CLOUD_URL = 'https://frink.example.com';

const { removeCredentialsMock, setDeliveryMock, startConsentMock, tokenGrantMock, probeMock } =
  vi.hoisted(() => ({
    probeMock: vi.fn(async () => {}),
    removeCredentialsMock: vi.fn(async () => ['plugin_notiontest_notion']),
    setDeliveryMock: vi.fn(async () => {}),
    tokenGrantMock: vi.fn(async () => ['plugin_notiontest_notion']),
    startConsentMock: vi.fn(
      async (): Promise<Record<string, { ok: boolean; error?: string; at: number }>> => ({
        plugin_notiontest_notion: { ok: true, at: 1 },
      }),
    ),
  }));

// Boundary mocks: the real consent opens the system browser and the real probe talks to a provider MCP.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../plugin-node-derivation/schema-cache', () => ({
  probeSchemasBestEffort: probeMock,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp/runtime/user-token-grant', () => ({ connectUserTokenMcp: tokenGrantMock }));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp/runtime/vendor-plugin-oauth', () => ({
  cancelVendorPluginMcpConsent: vi.fn(async () => {}),
  removeVendorPluginMcpCredentials: removeCredentialsMock,
  setVendorPluginMcpDeliveryEnabled: setDeliveryMock,
  startVendorPluginMcpConsent: startConsentMock,
}));
// An available catalog row beside the shipped Coming soon ones.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../shared/integrations/installable-plugins', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../../shared/integrations/installable-plugins')>();
  return {
    ...original,
    isMcpPluginId: (id: string) => id === 'notiontest' || original.isMcpPluginId(id),
  };
});
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../shared/integrations/plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../shared/integrations/plugins')>();
  const notion = original.getPluginDefinition('notion')!;
  const available = { ...notion, id: 'notiontest', availability: 'available' as const };
  // A skills-only package: available and vendor-pinned (so stage/unstage still fire), but with
  // no live MCP server — the shape under test never depends on one catalog row's launch gate.
  const neon = original.getPluginDefinition('neon')!;
  const skillsOnlyPackage = {
    ...neon,
    availability: 'available' as const,
    contents: { ...neon.contents, mcpServers: [] },
  };
  return {
    ...original,
    getPluginDefinition: (id: string) =>
      id === 'notiontest'
        ? available
        : id === 'neon'
          ? skillsOnlyPackage
          : original.getPluginDefinition(id),
  };
});

describe('chat-only plugin lifecycle', () => {
  let db: ReturnType<typeof freshDb>;
  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.spyOn(vendorStaging, 'stageVendorPlugin').mockResolvedValue(undefined);
    vi.spyOn(vendorStore, 'restageVendorPlugin').mockReturnValue(true);
    vi.spyOn(vendorStore, 'unstageVendorPlugin').mockImplementation(() => {});
    vi.spyOn(vendorStore, 'removeVendorPlugin').mockImplementation(() => {});
  });

  it.each(['clickup', 'vercel'])(
    'installs the official %s package and connects its MCP without an account grant',
    async (pluginId) => {
      const result = await installMcpPlugin(db, pluginId);
      expect(result.installation).toMatchObject({ pluginId, isInstalled: true });
      expect(vendorStaging.stageVendorPlugin).toHaveBeenCalledWith(pluginId);
      expect(startConsentMock).toHaveBeenCalledExactlyOnceWith(pluginId);
    },
  );

  it('a skills-only package installs and pauses without browser consent or a webhook account', async () => {
    const result = await installMcpPlugin(db, 'neon');
    expect(result.installation).toMatchObject({ isInstalled: true, isEnabled: true });
    expect(vendorStaging.stageVendorPlugin).toHaveBeenCalledWith('neon');
    expect(startConsentMock).not.toHaveBeenCalled();
    await setMcpPluginEnabled(db, 'neon', false);
    const pin = vendorPluginPin('neon')!;
    expect(vendorStore.unstageVendorPlugin).toHaveBeenCalledWith(`${pin.name}@${pin.marketplace}`);
    await setMcpPluginEnabled(db, 'neon', true);
    expect(vendorStaging.stageVendorPlugin).toHaveBeenCalledTimes(2);
    expect(startConsentMock).not.toHaveBeenCalled();
  });

  it('Add = install upsert then the chat consent, and a repeat Add re-runs only the consent', async () => {
    const first = await installMcpPlugin(db, 'notiontest');
    expect(first.installation).toMatchObject({
      pluginId: 'notiontest',
      isInstalled: true,
      isEnabled: true,
      sourceKind: 'frink_builtin',
    });
    expect(first.consent).toEqual({ plugin_notiontest_notion: { ok: true, at: 1 } });
    expect(startConsentMock).toHaveBeenCalledExactlyOnceWith('notiontest');
    const again = await installMcpPlugin(db, 'notiontest');
    expect(again.installation.id).toBe(first.installation.id);
    expect(startConsentMock).toHaveBeenCalledTimes(2);
  });

  it('stages the full package before fresh and existing consent, and leaves a turned-off installation unstaged', async () => {
    await installMcpPlugin(db, 'posthog');
    expect(vendorStaging.stageVendorPlugin).toHaveBeenCalledWith('posthog');
    expect(vi.mocked(vendorStaging.stageVendorPlugin).mock.invocationCallOrder[0]).toBeLessThan(
      startConsentMock.mock.invocationCallOrder[0],
    );
    await installMcpPlugin(db, 'posthog');
    expect(vendorStaging.stageVendorPlugin).toHaveBeenCalledTimes(2);
    await setMcpPluginEnabled(db, 'posthog', false);
    const pin = vendorPluginPin('posthog')!;
    expect(vendorStore.unstageVendorPlugin).toHaveBeenCalledWith(`${pin.name}@${pin.marketplace}`);
    vi.mocked(vendorStaging.stageVendorPlugin).mockClear();
    startConsentMock.mockClear();
    await installMcpPlugin(db, 'posthog');
    expect(vendorStaging.stageVendorPlugin).not.toHaveBeenCalled();
    expect(startConsentMock).not.toHaveBeenCalled();
  });

  it('Turn off and Remove never acquire a package, including an old MCP-only installation', async () => {
    await installationsRepo.install(db, {
      pluginId: 'posthog',
      sourceKind: 'frink_builtin',
      isEnabled: true,
      installedVersion: null,
    });
    vi.mocked(vendorStaging.stageVendorPlugin).mockRejectedValue(new Error('Offline'));
    await expect(setMcpPluginEnabled(db, 'posthog', false)).resolves.toMatchObject({
      isEnabled: false,
    });
    await expect(uninstallMcpPlugin(db, 'posthog')).resolves.toMatchObject({
      isInstalled: false,
    });
    expect(vendorStaging.stageVendorPlugin).not.toHaveBeenCalled();
    expect(removeCredentialsMock).toHaveBeenCalledWith('posthog');
  });

  it('a missing official package fails before the installed row or consent', async () => {
    vi.mocked(vendorStaging.stageVendorPlugin).mockRejectedValueOnce(
      new Error('Package unavailable'),
    );
    await expect(installMcpPlugin(db, 'posthog')).rejects.toThrow('Package unavailable');
    expect(await getByPluginId(db, 'posthog')).toBeNull();
    expect(startConsentMock).not.toHaveBeenCalled();
  });

  it('a failed Turn on restores the off package projection and keeps the stored credential', async () => {
    await installMcpPlugin(db, 'posthog');
    await setMcpPluginEnabled(db, 'posthog', false);
    vi.mocked(vendorStore.unstageVendorPlugin).mockClear();
    setDeliveryMock.mockRejectedValueOnce(new Error('Config locked'));
    await expect(setMcpPluginEnabled(db, 'posthog', true)).rejects.toThrow('Config locked');
    expect(await getByPluginId(db, 'posthog')).toMatchObject({ isEnabled: false });
    expect(vendorStore.unstageVendorPlugin).toHaveBeenCalled();
    expect(removeCredentialsMock).not.toHaveBeenCalled();
  });

  it('a package cleanup failure is retryable and happens after credential cleanup', async () => {
    await installMcpPlugin(db, 'posthog');
    vi.mocked(vendorStore.removeVendorPlugin).mockImplementationOnce(() => {
      throw new Error('Disk locked');
    });
    await expect(uninstallMcpPlugin(db, 'posthog')).rejects.toThrow('Disk locked');
    expect(await getByPluginId(db, 'posthog')).toMatchObject({ isInstalled: true });
    expect(removeCredentialsMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(vendorStore.removeVendorPlugin).mock.invocationCallOrder[0],
    );
    await uninstallMcpPlugin(db, 'posthog');
    expect(await getByPluginId(db, 'posthog')).toMatchObject({ isInstalled: false });
  });

  it('a failed consent is reported, never thrown — the caller decides whether the install survives', async () => {
    startConsentMock.mockResolvedValueOnce({
      plugin_notiontest_notion: { ok: false, error: 'Timed out', at: 1 },
    });
    const result = await installMcpPlugin(db, 'notiontest');
    expect(result.consent.plugin_notiontest_notion).toMatchObject({ ok: false });
    expect((await getByPluginId(db, 'notiontest'))?.isInstalled).toBe(true);
  });

  it('passes explicit reconnect to SDK consent while retaining the installed plugin', async () => {
    await installMcpPlugin(db, 'notiontest', { reconnect: true });
    expect(startConsentMock).toHaveBeenCalledWith('notiontest', undefined, { reconnect: true });
    expect((await getByPluginId(db, 'notiontest'))?.isInstalled).toBe(true);
  });

  it('refuses a Coming soon row', async () => {
    await expect(installMcpPlugin(db, 'docusign')).rejects.toThrow(/not available yet/);
  });

  it('still turns off and removes a plugin installed before its row went Coming soon', async () => {
    await installationsRepo.install(db, {
      pluginId: 'docusign',
      sourceKind: 'frink_builtin',
      installedVersion: null,
      isEnabled: true,
    });
    await expect(setMcpPluginEnabled(db, 'docusign', false)).resolves.toMatchObject({
      isEnabled: false,
    });
    await expect(setMcpPluginEnabled(db, 'docusign', true)).rejects.toThrow(/not available yet/);
    await expect(uninstallMcpPlugin(db, 'docusign')).resolves.toMatchObject({
      isInstalled: false,
    });
  });

  it('Turn off flips delivery before the row and keeps the credential; Turn on restores without a consent', async () => {
    await installMcpPlugin(db, 'notiontest');
    const off = await setMcpPluginEnabled(db, 'notiontest', false);
    expect(off.isEnabled).toBe(false);
    expect(setDeliveryMock).toHaveBeenLastCalledWith('notiontest', false);
    expect(removeCredentialsMock).not.toHaveBeenCalled();
    // A turned-off row never opens a browser on Add.
    startConsentMock.mockClear();
    expect((await installMcpPlugin(db, 'notiontest')).consent).toEqual({});
    expect(startConsentMock).not.toHaveBeenCalled();
    const on = await setMcpPluginEnabled(db, 'notiontest', true);
    expect(on.isEnabled).toBe(true);
    expect(setDeliveryMock).toHaveBeenLastCalledWith('notiontest', true);
    expect(startConsentMock).not.toHaveBeenCalled();
  });

  it('a delivery flip rejection leaves the row in its previous state', async () => {
    await installMcpPlugin(db, 'notiontest');
    setDeliveryMock.mockRejectedValueOnce(new Error('config locked'));
    await expect(setMcpPluginEnabled(db, 'notiontest', false)).rejects.toThrow('config locked');
    expect((await getByPluginId(db, 'notiontest'))?.isEnabled).toBe(true);
  });

  it('a Turn off that lands while the browser consent is open wins over the consent registration', async () => {
    await installMcpPlugin(db, 'notiontest');
    startConsentMock.mockImplementationOnce(async () => {
      await installationsRepo.setEnabled(db, 'notiontest', false);
      return { plugin_notiontest_notion: { ok: true, at: 2 } };
    });
    setDeliveryMock.mockClear();
    await installMcpPlugin(db, 'notiontest');
    expect(setDeliveryMock).toHaveBeenCalledExactlyOnceWith('notiontest', false);
  });

  it('a row write rejection flips delivery back so the two never diverge', async () => {
    await installMcpPlugin(db, 'notiontest');
    const closed = new Error('database is closed');
    const rowWrite = vi.spyOn(installationsRepo, 'setEnabled').mockRejectedValueOnce(closed);
    await expect(setMcpPluginEnabled(db, 'notiontest', false)).rejects.toThrow(closed);
    expect(setDeliveryMock.mock.calls.slice(-2)).toEqual([
      ['notiontest', false],
      ['notiontest', true],
    ]);
    rowWrite.mockRestore();
  });

  it('Remove sweeps the credential then tombstones; a failed sweep leaves the row installed for a retry', async () => {
    await installMcpPlugin(db, 'notiontest');
    removeCredentialsMock.mockRejectedValueOnce(new Error('store busy'));
    await expect(uninstallMcpPlugin(db, 'notiontest')).rejects.toThrow('store busy');
    expect((await getByPluginId(db, 'notiontest'))?.isInstalled).toBe(true);
    const tombstone = await uninstallMcpPlugin(db, 'notiontest');
    expect(tombstone).toMatchObject({ isInstalled: false, isEnabled: false });
    // Add resurrects the tombstone and consents again.
    const back = await installMcpPlugin(db, 'notiontest');
    expect(back.installation.isInstalled).toBe(true);
  });

  it('Remove deletes a destination this machine registered itself, and stops for a refusal', async () => {
    vi.spyOn(mcp, 'getGlobalMcpServers').mockResolvedValue({});
    vi.spyOn(mcp, 'getMcpCredentials').mockResolvedValue({
      oauth: { accessToken: 'pha_mcp_token' },
    });
    vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation((value) => value ?? null);
    const accountId = await insertIntegration(db, { provider: 'posthog' });
    const endpointId = await insertWebhookEndpoint(db, {
      integrationId: accountId,
      provider: 'posthog',
      pathToken: 'a'.repeat(64),
      subscribeKeyEncrypted: 'subscribe-key',
      signingSecretEncrypted: 'b'.repeat(64),
      vendorRef: 'us:42:fn_1',
    });
    try {
      await installMcpPlugin(db, 'posthog');
      vi.stubGlobal('fetch', fakePosthogApi('us', 'revoked').fetch);
      await expect(uninstallMcpPlugin(db, 'posthog')).rejects.toThrow(
        /Delete the "Frink" destination under Data pipeline/,
      );
      expect(removeCredentialsMock).not.toHaveBeenCalled();
      expect(endpointRow(db, endpointId)?.isActive).toBe(true);

      const posthog = fakePosthogApi('us');
      posthog.functions.set('fn_1', { name: 'Frink', url: 'x', deleted: false });
      vi.stubGlobal('fetch', posthog.fetch);
      await uninstallMcpPlugin(db, 'posthog');
      expect(posthog.functions.get('fn_1')?.deleted).toBe(true);
      // The account this machine held goes with the plugin, and its address rows cascade.
      expect((await listLocalIntegrations(db)).some((row) => row.id === accountId)).toBe(false);
      expect(endpointRow(db, endpointId)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('a Remove that lands while the browser consent is open sweeps the credential the consent stored', async () => {
    await installMcpPlugin(db, 'notiontest');
    startConsentMock.mockImplementationOnce(async () => {
      await installationsRepo.uninstall(db, 'notiontest');
      return { plugin_notiontest_notion: { ok: true, at: 2 } };
    });
    removeCredentialsMock.mockClear();
    await installMcpPlugin(db, 'notiontest');
    expect(removeCredentialsMock).toHaveBeenCalledExactlyOnceWith('notiontest');
  });

  it('a redundant Turn on whose row write fails leaves delivery where the row is', async () => {
    await installMcpPlugin(db, 'notiontest');
    const rowWrite = vi
      .spyOn(installationsRepo, 'setEnabled')
      .mockRejectedValueOnce(new Error('closed'));
    await expect(setMcpPluginEnabled(db, 'notiontest', true)).rejects.toThrow('closed');
    expect(setDeliveryMock).toHaveBeenLastCalledWith('notiontest', true);
    rowWrite.mockRestore();
  });

  it('a Turn off that lands while the consent is open is the row Add reports back', async () => {
    await installMcpPlugin(db, 'notiontest');
    startConsentMock.mockImplementationOnce(async () => {
      await installationsRepo.setEnabled(db, 'notiontest', false);
      return { plugin_notiontest_notion: { ok: true, at: 2 } };
    });
    expect((await installMcpPlugin(db, 'notiontest')).installation.isEnabled).toBe(false);
  });

  it('a Remove that wins the row write during Turn on leaves nothing delivered', async () => {
    await installMcpPlugin(db, 'notiontest');
    vi.spyOn(installationsRepo, 'setEnabled').mockResolvedValueOnce(null);
    await expect(setMcpPluginEnabled(db, 'notiontest', true)).resolves.toMatchObject({
      isInstalled: true,
    });
    expect(setDeliveryMock).toHaveBeenLastCalledWith('notiontest', false);
    vi.restoreAllMocks();
  });

  it('grants a token only to an installed, turned-on plugin, under the plugin mutex', async () => {
    await expect(grantUserToken(db, 'notiontest', 'tok')).resolves.toEqual([
      'plugin_notiontest_notion',
    ]);
    expect(tokenGrantMock).toHaveBeenCalledExactlyOnceWith('notiontest', 'tok');
    await setMcpPluginEnabled(db, 'notiontest', false);
    await expect(grantUserToken(db, 'notiontest', 'tok')).rejects.toThrow(/Turn the plugin on/);
    await expect(grantUserToken(db, 'slack', 'tok')).rejects.toThrow(/not installed/);
  });

  it('setEnabled requires an installed row', async () => {
    await expect(setMcpPluginEnabled(db, 'notiontest', true)).rejects.toThrow(/not installed/);
  });

  it('re-probes node schemas after a successful consent and again on Turn on', async () => {
    await installMcpPlugin(db, 'notiontest');
    expect(probeMock).toHaveBeenCalledWith('notiontest');

    await setMcpPluginEnabled(db, 'notiontest', false);
    probeMock.mockClear();
    await setMcpPluginEnabled(db, 'notiontest', true);
    expect(probeMock).toHaveBeenCalledWith('notiontest');
  });

  it('never re-probes when a Turn off landed while the browser was open', async () => {
    startConsentMock.mockImplementationOnce(async () => {
      await setMcpPluginEnabled(db, 'notiontest', false);
      return { plugin_notiontest_notion: { ok: true, at: 1 } };
    });
    await installMcpPlugin(db, 'notiontest');
    expect(probeMock).not.toHaveBeenCalled();
  });
});
