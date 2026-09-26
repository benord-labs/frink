import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { ManifestInputProjection } from '../../../../shared/lib/flows/json-schema-to-manifest-inputs';
import { createId } from '../utils';

export const PLUGIN_CONNECTION_LIFECYCLE_STATES = [
  'active',
  'disabled',
  'disconnecting',
  'disconnected',
] as const;
export const PLUGIN_CONNECTION_PROVISIONING_STATES = [
  'pending',
  'ready',
  'user_managed',
  'failed',
] as const;
export const PLUGIN_CONNECTION_CLEANUP_STATES = ['idle', 'pending', 'failed', 'complete'] as const;
export const PLUGIN_CONNECTION_ERROR_CODES = [
  'configuration_invalid',
  'credential_binding_unavailable',
  'mcp_provision_failed',
  'upstream_revoke_failed',
  'managed_mcp_cleanup_failed',
  'webhook_cleanup_failed',
  'local_cleanup_failed',
  'unknown_lifecycle_failure',
] as const;

// Local product lifecycle for both Frink builtins and Agent Plugins v1 imports.
// A row records that a plugin is present, never that it is authenticated,
// granted a capability, or wired into an active Flow.
export const pluginInstallations = sqliteTable(
  'plugin_installations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    pluginId: text('plugin_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceLocator: text('source_locator'),
    installedVersion: text('installed_version'),
    isInstalled: integer('is_installed', { mode: 'boolean' }).notNull().default(true),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    installedAt: integer('installed_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    uninstalledAt: integer('uninstalled_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('plugin_installations_plugin_uq').on(table.pluginId),
    check(
      'plugin_installations_source_kind_check',
      sql`${table.sourceKind} IN ('frink_builtin', 'agent_plugins_v1')`,
    ),
    check('plugin_installations_is_installed_check', sql`${table.isInstalled} IN (0, 1)`),
    check('plugin_installations_is_enabled_check', sql`${table.isEnabled} IN (0, 1)`),
    check(
      'plugin_installations_tombstone_check',
      sql`${table.isInstalled} = 1 OR ${table.isEnabled} = 0`,
    ),
    check(
      'plugin_installations_builtin_locator_check',
      sql`${table.sourceKind} != 'frink_builtin' OR ${table.sourceLocator} IS NULL`,
    ),
    check(
      'plugin_installations_import_locator_check',
      sql`${table.sourceKind} != 'agent_plugins_v1' OR (${table.sourceLocator} IS NOT NULL AND length(trim(${table.sourceLocator})) > 0)`,
    ),
  ],
);

// Durable, machine-local operational state for one immutable cloud connection.
// Credentials stay in their existing stores; this table contains only lifecycle
// coordination metadata that is safe to project into the renderer.
export const pluginConnectionLifecycles = sqliteTable(
  'plugin_connection_lifecycles',
  {
    pluginId: text('plugin_id').notNull(),
    connectionId: text('connection_id').notNull(),
    lifecycleState: text('lifecycle_state', {
      enum: PLUGIN_CONNECTION_LIFECYCLE_STATES,
    })
      .notNull()
      .default('active'),
    provisioningState: text('provisioning_state', {
      enum: PLUGIN_CONNECTION_PROVISIONING_STATES,
    })
      .notNull()
      .default('pending'),
    cleanupState: text('cleanup_state', {
      enum: PLUGIN_CONNECTION_CLEANUP_STATES,
    })
      .notNull()
      .default('idle'),
    errorCode: text('error_code', { enum: PLUGIN_CONNECTION_ERROR_CODES }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({
      name: 'plugin_connection_lifecycles_connection_pk',
      columns: [table.connectionId],
    }),
    foreignKey({
      name: 'plugin_connection_lifecycles_installation_fk',
      columns: [table.pluginId],
      foreignColumns: [pluginInstallations.pluginId],
    }),
    check(
      'plugin_connection_lifecycles_lifecycle_check',
      sql`${table.lifecycleState} IN ('active', 'disabled', 'disconnecting', 'disconnected')`,
    ),
    check(
      'plugin_connection_lifecycles_provisioning_check',
      sql`${table.provisioningState} IN ('pending', 'ready', 'user_managed', 'failed')`,
    ),
    check(
      'plugin_connection_lifecycles_cleanup_check',
      sql`${table.cleanupState} IN ('idle', 'pending', 'failed', 'complete')`,
    ),
    check(
      'plugin_connection_lifecycles_error_code_check',
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN ('configuration_invalid', 'credential_binding_unavailable', 'mcp_provision_failed', 'upstream_revoke_failed', 'managed_mcp_cleanup_failed', 'webhook_cleanup_failed', 'local_cleanup_failed', 'unknown_lifecycle_failure')`,
    ),
  ],
);

// The projected tool schema a curated plugin action was last probed with. Node existence derives
// from connection state, never from this table; a row only shapes the form and preflight.
export const pluginNodeSchemas = sqliteTable(
  'plugin_node_schemas',
  {
    pluginId: text('plugin_id').notNull(),
    actionId: text('action_id').notNull(),
    inputs: text('inputs', { mode: 'json' })
      .$type<Record<string, ManifestInputProjection>>()
      .notNull(),
    unsupportedFields: text('unsupported_fields', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_node_schemas_plugin_action_pk',
      columns: [table.pluginId, table.actionId],
    }),
  ],
);
