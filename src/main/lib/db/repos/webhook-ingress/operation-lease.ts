/** The lease the hosted route kept in Neon, kept here instead: acquire, renew, release and the
 * write that ends an exchange are each one conditional UPDATE, so two writers cannot interleave. */

import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { getDatabase } from '../..';
import { integrationWebhooks } from '../../schema/webhook-ingress';
import type { LocalWebhookRow, MintedKeys } from './management';

type Db = ReturnType<typeof getDatabase>;

/** Long enough for the slowest vendor exchange, short enough that a force-quit self-heals. */
export const OPERATION_LEASE_TTL_MS = 5 * 60_000;

const OPERATION_LOST = 'Another trigger operation took over this address.';

/** What a finished vendor exchange records, against the generation the holder started from. */
export type VendorOutcome = {
  vendorRef: string | null;
  signingSecretEncrypted?: string;
  /** The address a relay move minted, written with the vendor's answer so the row leaves the old
   * relay and records what that removal cost in one place. */
  keys?: MintedKeys;
  lastError?: string | null;
  deactivate?: boolean;
  expected: { pathToken: string; vendorRef: string | null };
};

function expiry(ttlMs: number, now: Date): Date {
  return new Date(now.getTime() + ttlMs);
}

/** Free, expired, or already this caller's: any other state leaves the row untouched. */
export async function acquireOperation(
  db: Db,
  endpointId: string,
  operationId: string,
  ttlMs: number,
): Promise<LocalWebhookRow | undefined> {
  const now = new Date();
  const [row] = await db
    .update(integrationWebhooks)
    .set({ operationId, operationExpiresAt: expiry(ttlMs, now) })
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        or(
          isNull(integrationWebhooks.operationId),
          eq(integrationWebhooks.operationId, operationId),
          lt(integrationWebhooks.operationExpiresAt, now),
        ),
      ),
    )
    .returning();
  return row;
}

/** A holder that has lost the lease may start no further vendor request, so this throws. */
export async function renewOperation(
  db: Db,
  endpointId: string,
  operationId: string,
  ttlMs: number,
): Promise<void> {
  const now = new Date();
  const rows = await db
    .update(integrationWebhooks)
    .set({ operationExpiresAt: expiry(ttlMs, now) })
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.operationId, operationId),
        gt(integrationWebhooks.operationExpiresAt, now),
      ),
    )
    .returning({ id: integrationWebhooks.id });
  if (rows.length !== 1) throw new Error(OPERATION_LOST);
}

export async function releaseOperation(
  db: Db,
  endpointId: string,
  operationId: string,
): Promise<void> {
  await db
    .update(integrationWebhooks)
    .set({ operationId: null, operationExpiresAt: null })
    .where(
      and(eq(integrationWebhooks.id, endpointId), eq(integrationWebhooks.operationId, operationId)),
    );
}

/** Written only by the live lease holder, and only onto the generation it read. */
export async function writeVendorOutcome(
  db: Db,
  endpointId: string,
  operationId: string,
  outcome: VendorOutcome,
): Promise<LocalWebhookRow | undefined> {
  const now = new Date();
  const next: Partial<typeof integrationWebhooks.$inferInsert> = {
    vendorRef: outcome.vendorRef,
    lastError: outcome.lastError ?? null,
    lastErrorAt: outcome.lastError ? now : null,
    updatedAt: now,
  };
  // The address changed, so nothing the old one received is still this endpoint's last event.
  if (outcome.keys) Object.assign(next, outcome.keys, { lastReceivedAt: null });
  if (outcome.signingSecretEncrypted) next.signingSecretEncrypted = outcome.signingSecretEncrypted;
  if (outcome.deactivate) next.isActive = false;
  const [row] = await db
    .update(integrationWebhooks)
    .set(next)
    .where(
      and(
        eq(integrationWebhooks.id, endpointId),
        eq(integrationWebhooks.operationId, operationId),
        gt(integrationWebhooks.operationExpiresAt, now),
        eq(integrationWebhooks.pathToken, outcome.expected.pathToken),
        outcome.expected.vendorRef === null
          ? isNull(integrationWebhooks.vendorRef)
          : eq(integrationWebhooks.vendorRef, outcome.expected.vendorRef),
      ),
    )
    .returning();
  return row;
}
