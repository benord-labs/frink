import { and, eq } from 'drizzle-orm';
import { PLUGIN_DEFINITIONS } from '../../../../../shared/integrations/plugins';
import type { getDatabase } from '../..';
import { pluginInstallations } from '../../schema';

type Db = ReturnType<typeof getDatabase>;
export type PluginInstallation = typeof pluginInstallations.$inferSelect;

type InstallBase = {
  pluginId: string;
  installedVersion?: string | null;
  isEnabled?: boolean;
};

export type InstallPluginInput = InstallBase &
  ({ sourceKind: 'frink_builtin' } | { sourceKind: 'agent_plugins_v1'; sourceLocator: string });

const BUILTIN_PLUGIN_IDS = new Set(
  PLUGIN_DEFINITIONS.filter((definition) => definition.source.kind === 'frink_builtin').map(
    (definition) => definition.id,
  ),
);

/**
 * Lists every local lifecycle row, including uninstall tombstones. Callers need
 * tombstones to distinguish "never installed" from an explicit uninstall; the
 * product selector decides which rows are visible in an installed-only view.
 */
export async function listInstallations(db: Db): Promise<PluginInstallation[]> {
  return db.select().from(pluginInstallations);
}

/** Every row that is installed and on — the startup connect-unwind input. */
export async function listEnabledInstallations(db: Db): Promise<PluginInstallation[]> {
  return db
    .select()
    .from(pluginInstallations)
    .where(and(eq(pluginInstallations.isInstalled, true), eq(pluginInstallations.isEnabled, true)));
}

export async function getByPluginId(db: Db, pluginId: string): Promise<PluginInstallation | null> {
  const [row] = await db
    .select()
    .from(pluginInstallations)
    .where(eq(pluginInstallations.pluginId, pluginId))
    .limit(1);
  return row ?? null;
}

/**
 * Explicit install/reinstall. The unique plugin key turns concurrent
 * install attempts into one stable row; reinstalling clears any tombstone.
 */
export async function install(db: Db, input: InstallPluginInput): Promise<PluginInstallation> {
  if (input.sourceKind === 'agent_plugins_v1' && BUILTIN_PLUGIN_IDS.has(input.pluginId)) {
    throw new Error(`Plugin id ${input.pluginId} is reserved by a Frink builtin`);
  }

  return db.transaction(
    (tx) => {
      const existing = tx
        .select({ sourceKind: pluginInstallations.sourceKind })
        .from(pluginInstallations)
        .where(eq(pluginInstallations.pluginId, input.pluginId))
        .get();
      if (existing && existing.sourceKind !== input.sourceKind) {
        throw new Error(
          `Plugin id ${input.pluginId} is already owned by source ${existing.sourceKind}`,
        );
      }

      const now = new Date();
      const isEnabled = input.isEnabled ?? true;
      const sourceLocator = input.sourceKind === 'agent_plugins_v1' ? input.sourceLocator : null;
      const [row] = tx
        .insert(pluginInstallations)
        .values({
          pluginId: input.pluginId,
          sourceKind: input.sourceKind,
          sourceLocator,
          installedVersion: input.installedVersion ?? null,
          isInstalled: true,
          isEnabled,
          installedAt: now,
          uninstalledAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pluginInstallations.pluginId,
          set: {
            sourceLocator,
            installedVersion: input.installedVersion ?? null,
            isInstalled: true,
            isEnabled,
            installedAt: now,
            uninstalledAt: null,
            updatedAt: now,
          },
        })
        .returning()
        .all();
      if (!row) throw new Error(`Failed to install plugin ${input.pluginId}`);
      return row;
    },
    { behavior: 'immediate' },
  );
}

/** Enabling a tombstone is forbidden: reinstall is the only resurrection path. */
export async function setEnabled(
  db: Db,
  pluginId: string,
  isEnabled: boolean,
): Promise<PluginInstallation | null> {
  const [row] = await db
    .update(pluginInstallations)
    .set({ isEnabled, updatedAt: new Date() })
    .where(
      and(eq(pluginInstallations.pluginId, pluginId), eq(pluginInstallations.isInstalled, true)),
    )
    .returning();
  return row ?? null;
}

/** Uninstall is a retained tombstone; only an explicit reinstall can restore it. */
export async function uninstall(db: Db, pluginId: string): Promise<PluginInstallation | null> {
  const now = new Date();
  const [row] = await db
    .update(pluginInstallations)
    .set({
      isInstalled: false,
      isEnabled: false,
      uninstalledAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(pluginInstallations.pluginId, pluginId), eq(pluginInstallations.isInstalled, true)),
    )
    .returning();
  return row ?? null;
}
