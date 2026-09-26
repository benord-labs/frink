import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getConnectionLifecycle,
  isPluginExecutionAllowed,
} from '../../db/repos/plugin-connection-lifecycle';
import { getByPluginId } from '../../db/repos/plugin-installations';
import {
  listLocalIntegrations,
  listWebhookEndpointsForIntegration,
} from '../../db/repos/webhook-ingress';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { deactivateLocalEndpoint, type LocalEndpointIo } from '../../webhooks/local-endpoints';
import { sealedWebhookIo } from '../../webhooks/test-utils';
import {
  disconnectWebhookConnection,
  installWebhookPlugin,
  setWebhookPluginEnabled,
  uninstallWebhookPlugin,
} from './index';

const PLUGIN = 'generic_webhook';

describe('webhook plugin lifecycle', () => {
  let db: TestDb;
  let io: LocalEndpointIo;
  let claims: number;

  beforeEach(() => {
    db = freshDb();
    claims = 0;
    io = {
      ...sealedWebhookIo(
        db,
        async () => {},
        () => {},
      ),
      claimAddresses: () => {
        claims += 1;
      },
    };
  });
  afterEach(() => db.$client.close());

  async function accounts() {
    return (await listLocalIntegrations(db)).filter((row) => row.provider === PLUGIN);
  }

  async function endpoints() {
    const rows = [];
    for (const account of await accounts())
      rows.push(...(await listWebhookEndpointsForIntegration(db, account.id)));
    return rows;
  }

  it('installs with an account, a claimed address and an execution mapping', async () => {
    const row = await installWebhookPlugin(db, io, PLUGIN);

    expect(row).toMatchObject({ pluginId: PLUGIN, isInstalled: true, isEnabled: true });
    const [account] = await accounts();
    expect(await endpoints()).toHaveLength(1);
    expect(claims).toBe(1);
    expect(await getConnectionLifecycle(db, account.id)).toMatchObject({
      pluginId: PLUGIN,
      lifecycleState: 'active',
    });
  });

  it('serializes repeated connect without duplicating accounts or addresses', async () => {
    await Promise.all([installWebhookPlugin(db, io, PLUGIN), installWebhookPlugin(db, io, PLUGIN)]);

    expect(await accounts()).toHaveLength(1);
    expect(await endpoints()).toHaveLength(1);
  });

  it('pauses and resumes execution with the same account and address; Connect cannot undo pause', async () => {
    await installWebhookPlugin(db, io, PLUGIN);
    const before = await endpoints();
    await setWebhookPluginEnabled(db, PLUGIN, false);
    await installWebhookPlugin(db, io, PLUGIN);
    expect(await isPluginExecutionAllowed(db, PLUGIN)).toBe(false);
    await setWebhookPluginEnabled(db, PLUGIN, true);

    expect(await isPluginExecutionAllowed(db, PLUGIN)).toBe(true);
    expect(await endpoints()).toEqual(before);
  });

  it('keeps a failed first mint managed and retries against the same account', async () => {
    let sealFails = true;
    const flaky: LocalEndpointIo = {
      ...io,
      encryptSecret: (value) => {
        if (sealFails) {
          sealFails = false;
          throw new Error('keyring locked');
        }
        return io.encryptSecret(value);
      },
    };
    await expect(installWebhookPlugin(db, flaky, PLUGIN)).rejects.toThrow('keyring locked');
    const [account] = await accounts();
    expect(await getByPluginId(db, PLUGIN)).toMatchObject({ isInstalled: true });
    expect(await getConnectionLifecycle(db, account.id)).toBeNull();

    await installWebhookPlugin(db, flaky, PLUGIN);
    expect(await accounts()).toHaveLength(1);
    expect(await endpoints()).toHaveLength(1);
  });

  it('does not reactivate an intentionally deactivated address on Connect or Turn on', async () => {
    await installWebhookPlugin(db, io, PLUGIN);
    const [account] = await accounts();
    const [address] = await endpoints();
    expect((await deactivateLocalEndpoint(io, account, address.id)).success).toBe(true);

    await installWebhookPlugin(db, io, PLUGIN);
    await setWebhookPluginEnabled(db, PLUGIN, false);
    await setWebhookPluginEnabled(db, PLUGIN, true);
    expect(await endpoints()).toMatchObject([{ id: address.id, isActive: false }]);
  });

  it('removes every account on uninstall and keeps the disconnected mapping through reinstall', async () => {
    await installWebhookPlugin(db, io, PLUGIN);
    const [{ id: oldId }] = await accounts();
    await uninstallWebhookPlugin(db, PLUGIN);

    expect(await isPluginExecutionAllowed(db, PLUGIN)).toBe(false);
    expect(await accounts()).toEqual([]);
    expect(await listWebhookEndpointsForIntegration(db, oldId)).toEqual([]);

    await installWebhookPlugin(db, io, PLUGIN);
    expect(await getConnectionLifecycle(db, oldId)).toMatchObject({ lifecycleState: 'disconnected' });
    const [fresh] = await accounts();
    expect(fresh.id).not.toBe(oldId);
  });

  it('account Disconnect also removes the installation when it was the last account', async () => {
    await installWebhookPlugin(db, io, PLUGIN);
    const [account] = await accounts();
    await disconnectWebhookConnection(db, PLUGIN, account.id);

    expect(await getByPluginId(db, PLUGIN)).toMatchObject({ isInstalled: false });
    expect(await getConnectionLifecycle(db, account.id)).toMatchObject({
      lifecycleState: 'disconnected',
    });
    await expect(disconnectWebhookConnection(db, PLUGIN, account.id)).rejects.toThrow(
      'not on this machine',
    );
  });

  it('refuses a plugin outside the class this machine serves', async () => {
    await expect(installWebhookPlugin(db, io, 'posthog')).rejects.toThrow('not available');
  });
});
