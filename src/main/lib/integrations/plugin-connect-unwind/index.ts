/** Installed ⇒ something is connected, or the plugin is turned off: a connect attempt that ends with nothing connected leaves no install behind. */
import { isMcpPluginId } from '../../../../shared/integrations/installable-plugins';
import type { getDatabase } from '../../db';
import { listConnectionLifecycles } from '../../db/repos/plugin-connection-lifecycle';
import { getByPluginId, listEnabledInstallations } from '../../db/repos/plugin-installations';
import { hasStoredVendorPluginMcpCredential } from '../../mcp/runtime/vendor-plugin-mcp-status';
import { captureMainMessage } from '../../sentry/init';
import { withPluginLifecycleOperation } from '../connection-lifecycle-operation';
import { uninstallMcpPluginLocked } from '../plugin-mcp-lifecycle';

type Db = ReturnType<typeof getDatabase>;

/** An account in any state but disconnected: the one fact "keep the install" reads. */
async function accountHeld(db: Db, pluginId: string): Promise<boolean> {
  const lifecycles = await listConnectionLifecycles(db);
  return lifecycles.some((r) => r.pluginId === pluginId && r.lifecycleState !== 'disconnected');
}

/** True while anything still claims the install: a held account or a stored chat grant. */
async function somethingConnected(db: Db, pluginId: string): Promise<boolean> {
  if (await accountHeld(db, pluginId)) return true;
  return hasStoredVendorPluginMcpCredential(pluginId);
}

/** The check and the tombstone, for a caller that already holds the plugin mutex. */
async function unwindUnconnectedInstallLocked(db: Db, pluginId: string): Promise<void> {
  const row = await getByPluginId(db, pluginId);
  if (!row?.isInstalled || !row.isEnabled) return;
  if (await somethingConnected(db, pluginId)) return;
  if (isMcpPluginId(pluginId)) await uninstallMcpPluginLocked(db, pluginId);
}

/** The connect outcome the user sees is unchanged by an unwind failure, and nothing is ever revoked. */
async function contained(pluginId: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    captureMainMessage(`Plugin connect unwind failed: ${String(error)}`, 'warning', {
      surface: 'plugin-connect-unwind',
      pluginId,
    });
  }
}

/** Never throws. The check and the tombstone share one hold of the plugin mutex, so an activation or a re-Connect cannot interleave. */
export async function unwindUnconnectedInstall(db: Db, pluginId: string): Promise<void> {
  await contained(pluginId, () =>
    withPluginLifecycleOperation(pluginId, () => unwindUnconnectedInstallLocked(db, pluginId)),
  );
}

/** Runs a grant attempt, then unwinds whatever its outcome — the predicate is state, never the attempt's result. */
export async function withGrantUnwind<T>(
  db: Db,
  pluginId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await unwindUnconnectedInstall(db, pluginId);
  }
}

/** Startup: an app quit mid-consent is the one end of an attempt nobody reports. */
export async function unwindUnconnectedInstalls(db: Db): Promise<void> {
  for (const row of await listEnabledInstallations(db)) {
    await unwindUnconnectedInstall(db, row.pluginId);
  }
}
