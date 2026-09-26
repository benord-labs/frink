import { eq } from 'drizzle-orm';
import type { getDatabase } from '../..';
import {
  type PLUGIN_CONNECTION_CLEANUP_STATES,
  type PLUGIN_CONNECTION_ERROR_CODES,
  type PLUGIN_CONNECTION_LIFECYCLE_STATES,
  type PLUGIN_CONNECTION_PROVISIONING_STATES,
  pluginConnectionLifecycles,
  pluginInstallations,
} from '../../schema/plugin-installations';

type Db = ReturnType<typeof getDatabase>;
export type PluginConnectionLifecycle = typeof pluginConnectionLifecycles.$inferSelect;
type PluginConnectionLifecycleState = (typeof PLUGIN_CONNECTION_LIFECYCLE_STATES)[number];
type PluginConnectionProvisioningState = (typeof PLUGIN_CONNECTION_PROVISIONING_STATES)[number];
type PluginConnectionCleanupState = (typeof PLUGIN_CONNECTION_CLEANUP_STATES)[number];
type PluginConnectionErrorCode = (typeof PLUGIN_CONNECTION_ERROR_CODES)[number];

export type UpsertConnectionLifecycleInput = {
  pluginId: string;
  connectionId: string;
  lifecycleState?: PluginConnectionLifecycleState;
  provisioningState?: PluginConnectionProvisioningState;
  cleanupState?: PluginConnectionCleanupState;
  errorCode?: PluginConnectionErrorCode | null;
};

export type PluginConnectionLifecycleSnapshot = {
  pluginId: string;
  connectionId: string;
  lifecycleState: PluginConnectionLifecycleState;
  provisioningState: PluginConnectionProvisioningState;
  cleanupState: PluginConnectionCleanupState;
  errorCode: PluginConnectionErrorCode | null;
  sanitizedError: string | null;
};

const SANITIZED_ERROR_MESSAGES: Record<PluginConnectionErrorCode, string> = {
  configuration_invalid: 'The plugin connection configuration is invalid.',
  credential_binding_unavailable: 'The connection credential could not be bound to this plugin.',
  mcp_provision_failed: 'The managed MCP could not be provisioned.',
  upstream_revoke_failed: 'The provider connection could not be revoked yet.',
  managed_mcp_cleanup_failed: 'The managed MCP could not be removed yet.',
  webhook_cleanup_failed: 'Provider webhook cleanup is incomplete.',
  local_cleanup_failed: 'Local connection cleanup is incomplete.',
  unknown_lifecycle_failure: 'The plugin connection operation did not complete.',
};

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

export function toConnectionLifecycleSnapshot(
  row: PluginConnectionLifecycle,
): PluginConnectionLifecycleSnapshot {
  return {
    pluginId: row.pluginId,
    connectionId: row.connectionId,
    lifecycleState: row.lifecycleState,
    provisioningState: row.provisioningState,
    cleanupState: row.cleanupState,
    errorCode: row.errorCode,
    sanitizedError: row.errorCode ? SANITIZED_ERROR_MESSAGES[row.errorCode] : null,
  };
}

export async function getConnectionLifecycle(
  db: Db,
  connectionId: string,
): Promise<PluginConnectionLifecycle | null> {
  const row = await db
    .select()
    .from(pluginConnectionLifecycles)
    .where(eq(pluginConnectionLifecycles.connectionId, connectionId))
    .get();
  return row ?? null;
}

export async function listConnectionLifecycles(db: Db): Promise<PluginConnectionLifecycle[]> {
  return db.select().from(pluginConnectionLifecycles);
}

function buildLifecycleUpdate(
  input: UpsertConnectionLifecycleInput,
  now: Date,
): Partial<typeof pluginConnectionLifecycles.$inferInsert> {
  const update: Partial<typeof pluginConnectionLifecycles.$inferInsert> = { updatedAt: now };
  if (input.lifecycleState !== undefined) update.lifecycleState = input.lifecycleState;
  if (input.provisioningState !== undefined) update.provisioningState = input.provisioningState;
  if (input.cleanupState !== undefined) update.cleanupState = input.cleanupState;
  if (input.errorCode !== undefined) update.errorCode = input.errorCode;
  return update;
}

function buildLifecycleInsert(
  input: UpsertConnectionLifecycleInput,
  ids: { pluginId: string; connectionId: string },
  now: Date,
): typeof pluginConnectionLifecycles.$inferInsert {
  return {
    ...ids,
    lifecycleState: input.lifecycleState ?? 'active',
    provisioningState: input.provisioningState ?? 'pending',
    cleanupState: input.cleanupState ?? 'idle',
    errorCode: input.errorCode ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Idempotently merges operational state for one immutable connection. Omitted
 * fields preserve the durable value; explicit null clears nullable metadata.
 */
export async function upsertConnectionLifecycle(
  db: Db,
  input: UpsertConnectionLifecycleInput,
): Promise<PluginConnectionLifecycle> {
  const pluginId = requireIdentifier(input.pluginId, 'pluginId');
  const connectionId = requireIdentifier(input.connectionId, 'connectionId');

  return db.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(pluginConnectionLifecycles)
        .where(eq(pluginConnectionLifecycles.connectionId, connectionId))
        .get();
      const now = new Date();

      if (existing) {
        if (existing.pluginId !== pluginId) {
          throw new Error(
            `Connection ${connectionId} is already owned by plugin ${existing.pluginId}`,
          );
        }
        const [row] = tx
          .update(pluginConnectionLifecycles)
          .set(buildLifecycleUpdate(input, now))
          .where(eq(pluginConnectionLifecycles.connectionId, connectionId))
          .returning()
          .all();
        if (!row) throw new Error(`Failed to update connection lifecycle ${connectionId}`);
        return row;
      }

      const [row] = tx
        .insert(pluginConnectionLifecycles)
        .values(buildLifecycleInsert(input, { pluginId, connectionId }, now))
        .returning()
        .all();
      if (!row) throw new Error(`Failed to create connection lifecycle ${connectionId}`);
      return row;
    },
    { behavior: 'immediate' },
  );
}

/** Missing lifecycle state is an incomplete connection and always fails closed. */
export async function isConnectionExecutionAllowed(
  db: Db,
  connectionId: string,
  pluginId: string,
): Promise<boolean> {
  const row = await getConnectionLifecycle(db, connectionId);
  return row?.pluginId === pluginId && row.lifecycleState === 'active';
}

/** Missing installation state is never permission to execute. */
export async function isPluginExecutionAllowed(db: Db, pluginId: string): Promise<boolean> {
  const [row] = await db
    .select({
      isInstalled: pluginInstallations.isInstalled,
      isEnabled: pluginInstallations.isEnabled,
    })
    .from(pluginInstallations)
    .where(eq(pluginInstallations.pluginId, pluginId))
    .limit(1);
  return Boolean(row?.isInstalled && row.isEnabled);
}
