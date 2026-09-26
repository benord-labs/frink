import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createId } from '../utils';

function requiredTimestamp(name: 'created_at' | 'updated_at') {
  return integer(name, { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date());
}

/** A connected account an inbound endpoint belongs to. `id` is carried over verbatim, because a
 * Flow's webhook_trigger names it and a fresh id silently stops matching. */
export const integrations = sqliteTable('integrations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  provider: text('provider').notNull(),
  externalUserId: text('external_user_id'),
  /** The key an api_token registrar calls the vendor with, as safeStorage ciphertext. */
  apiTokenEncrypted: text('api_token_encrypted'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: requiredTimestamp('created_at'),
  updatedAt: requiredTimestamp('updated_at'),
});

/** One inbound address. `path_token` is the public half of the subscribe key and is stored in the
 * clear because it IS the public value; both secrets are safeStorage ciphertext. */
export const integrationWebhooks = sqliteTable(
  'integration_webhooks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    integrationId: text('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    pathToken: text('path_token').notNull().unique(),
    subscribeKeyEncrypted: text('subscribe_key_encrypted').notNull(),
    signingSecretEncrypted: text('signing_secret_encrypted').notNull(),
    vendorRef: text('vendor_ref'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastReceivedAt: integer('last_received_at', { mode: 'timestamp' }),
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at', { mode: 'timestamp' }),
    /** Who holds this row's vendor exchange, and until when. Null = free. */
    operationId: text('operation_id'),
    operationExpiresAt: integer('operation_expires_at', { mode: 'timestamp' }),
    createdAt: requiredTimestamp('created_at'),
    updatedAt: requiredTimestamp('updated_at'),
  },
  (table) => [
    index('integration_webhooks_integration_active_idx').on(table.integrationId, table.isActive),
    check('integration_webhooks_path_token_check', sql`length(${table.pathToken}) = 64`),
    check(
      'integration_webhooks_subscribe_key_check',
      sql`length(${table.subscribeKeyEncrypted}) > 0`,
    ),
    check(
      'integration_webhooks_signing_secret_check',
      sql`length(${table.signingSecretEncrypted}) > 0`,
    ),
  ],
);
