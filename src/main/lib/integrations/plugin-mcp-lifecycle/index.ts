/** Install/enable/uninstall for a chat-only catalog plugin — plugin_installations plus the chat credential. Remove is the one Disconnect. */
import { TRPCError } from '@trpc/server';
import { isMcpPluginId } from '../../../../shared/integrations/installable-plugins';
import { getPluginDefinition } from '../../../../shared/integrations/plugins';
import { vendorPluginPin } from '../../../../shared/integrations/vendor-plugin-pins';
import {
  removeVendorPlugin,
  restageVendorPlugin,
  unstageVendorPlugin,
} from '../../claude/session-config-dir';
import type { getDatabase } from '../../db';
import {
  getByPluginId as getPluginInstallationById,
  install as installPlugin,
  setEnabled as setInstallationEnabled,
  uninstall as uninstallInstallation,
  type PluginInstallation,
} from '../../db/repos/plugin-installations';
import {
  cancelVendorPluginMcpConsent,
  removeVendorPluginMcpCredentials,
  setVendorPluginMcpDeliveryEnabled,
  startVendorPluginMcpConsent,
  type VendorPluginConsentOutcome,
  type VendorPluginConsentOptions,
} from '../../mcp/runtime/vendor-plugin-oauth';
import { connectUserTokenMcp } from '../../mcp/runtime/user-token-grant';
import { withPluginLifecycleOperation } from '../connection-lifecycle-operation';
import { stageVendorPlugin } from './vendor-staging';
import { probeSchemasBestEffort } from '../plugin-node-derivation/schema-cache';
import { ensureLocalAccountIdentity } from './account-identity';
import { listLocalIntegrations } from '../../db/repos/webhook-ingress';
import { localEndpointIo, removeLocalTriggersForProvider } from '../../webhooks';
import { forgetLocalTriggerAccount } from '../plugin-webhook-lifecycle';

type Db = ReturnType<typeof getDatabase>;

/** Availability gates adding or turning ON a plugin (both register a vendor webhook), never turning
 * off or removing one already installed: a row that turns Coming soon must stay removable. */
function requireMcpDefinition(pluginId: string) {
  const definition = getPluginDefinition(pluginId);
  if (
    (!isMcpPluginId(pluginId) && !vendorPluginPin(pluginId)) ||
    definition?.availability !== 'available'
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This plugin is not available yet.',
    });
  }
  return definition;
}

async function requireInstalled(db: Db, pluginId: string): Promise<PluginInstallation> {
  const installation = await getPluginInstallationById(db, pluginId);
  if (!installation?.isInstalled) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This plugin is not installed.' });
  }
  return installation;
}

/** Add = idempotent install upsert, then the chat consent (2026-08-18 Target); a turned-off row never opens a browser. */
export async function installMcpPlugin(
  db: Db,
  pluginId: string,
  options: VendorPluginConsentOptions = {},
): Promise<{
  installation: PluginInstallation;
  consent: Record<string, VendorPluginConsentOutcome>;
}> {
  const definition = requireMcpDefinition(pluginId);
  const { installation } = await withPluginLifecycleOperation(pluginId, async () => {
    const existing = await getPluginInstallationById(db, pluginId);
    if (existing?.isInstalled && !existing.isEnabled) {
      return { installation: existing, freshInstall: false };
    }
    try {
      await stageVendorPlugin(pluginId);
      if (existing?.isInstalled) return { installation: existing, freshInstall: false };
      return {
        installation: await installPlugin(db, {
          pluginId: definition.id,
          sourceKind: 'frink_builtin',
          installedVersion: null,
          isEnabled: true,
        }),
        freshInstall: true,
      };
    } catch (error) {
      if (!existing?.isEnabled) {
        const pin = vendorPluginPin(pluginId);
        if (pin) unstageVendorPlugin(`${pin.name}@${pin.marketplace}`);
      }
      throw error;
    }
  });
  if (!installation.isEnabled || !definition.contents.mcpServers.length)
    return { installation, consent: {} };
  // Outside the plugin mutex: the browser wait can last ten minutes and the consent is single-flight per server.
  const consent = options.reconnect
    ? await startVendorPluginMcpConsent(pluginId, undefined, { reconnect: true })
    : await startVendorPluginMcpConsent(pluginId);
  // The consent registers its server enabled; a Turn off or Remove that landed while the browser was open has the last word.
  const settled = await withPluginLifecycleOperation(pluginId, async () => {
    const row = await getPluginInstallationById(db, pluginId);
    if (!row?.isInstalled) await removeVendorPluginMcpCredentials(pluginId);
    else if (!row.isEnabled) {
      await setVendorPluginMcpDeliveryEnabled(pluginId, false);
      const pin = vendorPluginPin(pluginId);
      if (pin) unstageVendorPlugin(`${pin.name}@${pin.marketplace}`);
    } else {
      await probeSchemasBestEffort(pluginId);
      await ensureLocalAccountIdentity(db, pluginId);
    }
    return row ?? installation;
  });
  return { installation: settled, consent };
}

/** Remove = sweep the chat credential and this machine's trigger rows, then tombstone; a failed sweep leaves the row installed so Remove can be retried. */
export async function uninstallMcpPlugin(
  db: Db,
  pluginId: string,
): Promise<PluginInstallation | null> {
  return withPluginLifecycleOperation(pluginId, () => uninstallMcpPluginLocked(db, pluginId));
}

/** The uninstall body for a caller that already holds the plugin mutex (the connect unwind). */
export async function uninstallMcpPluginLocked(
  db: Db,
  pluginId: string,
): Promise<PluginInstallation | null> {
  // Vendor subscriptions first: removing them needs the credential the sweep is about to delete. A miss keeps the row installed so Remove can be retried.
  const localCleanup = await removeLocalTriggersForProvider(localEndpointIo(db), pluginId);
  if (!localCleanup.ok) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: localCleanup.reason });
  }
  for (const account of await listLocalIntegrations(db))
    if (account.provider === pluginId) await forgetLocalTriggerAccount(db, pluginId, account.id);
  await removeVendorPluginMcpCredentials(pluginId);
  const pin = vendorPluginPin(pluginId);
  if (pin) removeVendorPlugin(`${pin.name}@${pin.marketplace}`);
  return await uninstallInstallation(db, pluginId);
}

/** Turn off pauses delivery and keeps the credential; delivery flips first so 'disabled' never coexists with live tools, and returns to the row's state if the row write fails. */
export async function setMcpPluginEnabled(
  db: Db,
  pluginId: string,
  enabled: boolean,
): Promise<PluginInstallation> {
  if (enabled) requireMcpDefinition(pluginId);
  return withPluginLifecycleOperation(pluginId, async () => {
    const before = await requireInstalled(db, pluginId);
    const pin = vendorPluginPin(pluginId);
    let row: PluginInstallation | null = null;
    try {
      if (enabled) await stageVendorPlugin(pluginId);
      else await cancelVendorPluginMcpConsent(pluginId);
      await setVendorPluginMcpDeliveryEnabled(pluginId, enabled);
      if (!enabled && pin) unstageVendorPlugin(`${pin.name}@${pin.marketplace}`);
      row = await setInstallationEnabled(db, pluginId, enabled);
    } catch (error) {
      if (before.isEnabled && pin) restageVendorPlugin(pin);
      await setVendorPluginMcpDeliveryEnabled(pluginId, before.isEnabled);
      if (!before.isEnabled && pin) unstageVendorPlugin(`${pin.name}@${pin.marketplace}`);
      throw error;
    }
    // The row vanished under us (a Remove won): nothing may stay delivered.
    if (!row) {
      await setVendorPluginMcpDeliveryEnabled(pluginId, false);
      if (pin) unstageVendorPlugin(`${pin.name}@${pin.marketplace}`);
      return requireInstalled(db, pluginId);
    }
    // Turn on re-probes after the row is written; the palette follows the row itself. It is also the
    // retry for an identity lookup that failed at install, as the hosted lookup's was.
    if (enabled) {
      await probeSchemasBestEffort(pluginId);
      await ensureLocalAccountIdentity(db, pluginId);
    }
    return row;
  });
}

/** Token grant for a server with no OAuth path: the row must be on, and the grant runs under the plugin mutex so a Remove or Turn off cannot interleave. */
export async function grantUserToken(db: Db, pluginId: string, token: string): Promise<string[]> {
  if (isMcpPluginId(pluginId)) await installMcpPlugin(db, pluginId);
  return withPluginLifecycleOperation(pluginId, async () => {
    const row = await requireInstalled(db, pluginId);
    if (!row.isEnabled) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Turn the plugin on before adding a token.',
      });
    }
    const servers = await connectUserTokenMcp(pluginId, token);
    await probeSchemasBestEffort(pluginId);
    return servers;
  });
}
