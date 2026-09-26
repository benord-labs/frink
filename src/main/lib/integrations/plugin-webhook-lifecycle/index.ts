/** Webhook-only plugins use the same installation, account identity and execution gates as other
 * plugins; their account and address live on this machine, so nothing here needs a Frink account. */
import { TRPCError } from '@trpc/server';
import { isWebhookPluginId } from '../../../../shared/integrations/installable-plugins';
import { getProviderById, mintsLocally } from '../../../../shared/integrations/selectors';
import type { getDatabase } from '../../db';
import {
  getConnectionLifecycle,
  listConnectionLifecycles,
  upsertConnectionLifecycle,
} from '../../db/repos/plugin-connection-lifecycle';
import { getByPluginId, install, setEnabled, uninstall } from '../../db/repos/plugin-installations';
import { deleteLocalIntegration, listLocalIntegrations } from '../../db/repos/webhook-ingress';
import {
  createLocalTriggerAccount,
  listLocalEndpoints,
  type LocalEndpointIo,
  type LocalTriggerAccount,
  mintLocalEndpoint,
  WEBHOOK_ENDPOINT_LIMIT,
} from '../../webhooks/local-endpoints';
import {
  withConnectionLifecycleOperation,
  withPluginLifecycleOperation,
} from '../connection-lifecycle-operation';

type Db = ReturnType<typeof getDatabase>;

function requireWebhookProvider(pluginId: string) {
  const provider = getProviderById(pluginId);
  if (!provider || !isWebhookPluginId(pluginId) || !mintsLocally(provider)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This webhook plugin is not available.',
    });
  }
  return provider;
}

async function localAccounts(db: Db, pluginId: string): Promise<LocalTriggerAccount[]> {
  return (await listLocalIntegrations(db)).filter((row) => row.provider === pluginId);
}

async function markDisconnected(db: Db, pluginId: string, connectionId: string) {
  await upsertConnectionLifecycle(db, {
    pluginId,
    connectionId,
    lifecycleState: 'disconnected',
    cleanupState: 'complete',
    errorCode: null,
  });
}

/** Delivery stops before the rows go and the row records how the delete ended: no queued event dispatches
 * for a deleted account, a failed delete stays visible, and a mint queued behind it finds no account. */
export async function forgetLocalTriggerAccount(db: Db, pluginId: string, connectionId: string) {
  return withConnectionLifecycleOperation(connectionId, () =>
    forgetHeldAccount(db, pluginId, connectionId),
  );
}

/** The same, for a caller that already holds the account's lock across its own vendor cleanup. */
export async function forgetHeldAccount(db: Db, pluginId: string, connectionId: string) {
  const tracked = (await getConnectionLifecycle(db, connectionId)) !== null;
  const identity = { pluginId, connectionId };
  if (tracked)
    await upsertConnectionLifecycle(db, {
      ...identity,
      lifecycleState: 'disconnecting',
      cleanupState: 'pending',
    });
  try {
    await deleteLocalIntegration(db, connectionId);
  } catch (error) {
    if (tracked)
      await upsertConnectionLifecycle(db, {
        ...identity,
        cleanupState: 'failed',
        errorCode: 'webhook_cleanup_failed',
      });
    throw error;
  }
  if (tracked) await markDisconnected(db, pluginId, connectionId);
}

/** Ready is written only once the address exists, so no row ever claims a setup that failed. */
async function armAccount(
  db: Db,
  io: LocalEndpointIo,
  pluginId: string,
  account: LocalTriggerAccount,
) {
  if (!(await listLocalEndpoints(io, account)).length) {
    const minted = await mintLocalEndpoint(io, account, WEBHOOK_ENDPOINT_LIMIT);
    if (!minted.success)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The plugin was added, but webhook setup failed. Retry setup in Triggers.',
      });
  }
  await upsertConnectionLifecycle(db, {
    pluginId,
    connectionId: account.id,
    lifecycleState: 'active',
    provisioningState: 'ready',
    cleanupState: 'idle',
    errorCode: null,
  });
}

/** Connect reuses the immutable account and its first address; it never turns a paused plugin back on. */
export async function installWebhookPlugin(db: Db, io: LocalEndpointIo, pluginId: string) {
  requireWebhookProvider(pluginId);
  return withPluginLifecycleOperation(pluginId, async () => {
    const before = await getByPluginId(db, pluginId);
    if (before?.isInstalled && !before.isEnabled) return before;
    const installation = before?.isInstalled
      ? before
      : await install(db, { pluginId, sourceKind: 'frink_builtin', isEnabled: true });
    const accounts = await localAccounts(db, pluginId);
    if (!accounts.length)
      accounts.push({ id: await createLocalTriggerAccount(io, pluginId), provider: pluginId });
    for (const account of accounts) await armAccount(db, io, pluginId, account);
    return installation;
  });
}

/** Pause retains the address and account so resume does not require vendor reconfiguration. */
export async function setWebhookPluginEnabled(db: Db, pluginId: string, enabled: boolean) {
  requireWebhookProvider(pluginId);
  return withPluginLifecycleOperation(pluginId, async () => {
    const row = await setEnabled(db, pluginId, enabled);
    if (!row)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This plugin is not installed.',
      });
    return row;
  });
}

/** Remove pauses first, then forgets every account this machine holds for the plugin. */
export async function uninstallWebhookPlugin(db: Db, pluginId: string) {
  requireWebhookProvider(pluginId);
  return withPluginLifecycleOperation(pluginId, async () => {
    await setEnabled(db, pluginId, false);
    for (const account of await localAccounts(db, pluginId))
      await forgetLocalTriggerAccount(db, pluginId, account.id);
    // Mappings with no account row left (an earlier partial removal) settle with the plugin.
    for (const row of await listConnectionLifecycles(db))
      if (row.pluginId === pluginId) await markDisconnected(db, pluginId, row.connectionId);
    return uninstall(db, pluginId);
  });
}

/** Account details removes only the selected account; removing the last also removes the plugin. */
export async function disconnectWebhookConnection(
  db: Db,
  pluginId: string,
  connectionId: string,
) {
  requireWebhookProvider(pluginId);
  return withPluginLifecycleOperation(pluginId, async () => {
    const accounts = await localAccounts(db, pluginId);
    if (!accounts.some((row) => row.id === connectionId))
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'This trigger account is not on this machine.',
      });
    await forgetLocalTriggerAccount(db, pluginId, connectionId);
    if (accounts.length === 1) await uninstall(db, pluginId);
    return { success: true as const, cleanupPending: false as const };
  });
}
