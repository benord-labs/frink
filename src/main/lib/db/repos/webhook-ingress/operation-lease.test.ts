import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { integrationWebhooks } from '../../schema/webhook-ingress';
import { freshDb } from '../../test-utils/fresh-db';
import {
  acquireOperation,
  insertIntegration,
  insertWebhookEndpoint,
  releaseOperation,
  renewOperation,
  writeVendorOutcome,
} from '.';

type Db = ReturnType<typeof freshDb>;

const TOKEN = 'c'.repeat(64);
const TTL = 5 * 60_000;
const HOLDER = 'this-run';

async function seed(db: Db) {
  const integrationId = await insertIntegration(db, { provider: 'posthog' });
  return insertWebhookEndpoint(db, {
    integrationId,
    provider: 'posthog',
    pathToken: TOKEN,
    subscribeKeyEncrypted: 'sealed-k',
    signingSecretEncrypted: 'sealed-s',
  });
}

function readRow(db: Db, endpointId: string) {
  return db.select().from(integrationWebhooks).where(eq(integrationWebhooks.id, endpointId)).get();
}

describe('local trigger operation lease', () => {
  it('lets one holder through, refuses the next, and frees the row once it expires', async () => {
    const db = freshDb();
    const endpointId = await seed(db);

    expect(await acquireOperation(db, endpointId, HOLDER, TTL)).toMatchObject({ id: endpointId });
    expect(await acquireOperation(db, endpointId, 'another-run', TTL)).toBeUndefined();
    // The same holder may re-enter; that is how a retry inside one run continues.
    expect(await acquireOperation(db, endpointId, HOLDER, TTL)).toMatchObject({ id: endpointId });

    await acquireOperation(db, endpointId, HOLDER, -10_000);
    expect(await acquireOperation(db, endpointId, 'another-run', TTL)).toMatchObject({
      id: endpointId,
    });
    db.$client.close();
  });

  it('renews only the live holder and releases only its own lease', async () => {
    const db = freshDb();
    const endpointId = await seed(db);
    await acquireOperation(db, endpointId, HOLDER, TTL);

    await expect(renewOperation(db, endpointId, HOLDER, TTL)).resolves.toBeUndefined();
    await expect(renewOperation(db, endpointId, 'another-run', TTL)).rejects.toThrow();

    await releaseOperation(db, endpointId, 'another-run');
    expect(readRow(db, endpointId)?.operationId).toBe(HOLDER);
    await releaseOperation(db, endpointId, HOLDER);
    expect(readRow(db, endpointId)?.operationId).toBeNull();

    await acquireOperation(db, endpointId, HOLDER, -10_000);
    await expect(renewOperation(db, endpointId, HOLDER, TTL)).rejects.toThrow();
    db.$client.close();
  });

  it('records the vendor answer only for the holder and only on the generation it read', async () => {
    const db = freshDb();
    const endpointId = await seed(db);
    await acquireOperation(db, endpointId, HOLDER, TTL);
    const expected = { pathToken: TOKEN, vendorRef: null };

    expect(
      await writeVendorOutcome(db, endpointId, 'another-run', { vendorRef: 'x', expected }),
    ).toBeUndefined();
    expect(
      await writeVendorOutcome(db, endpointId, HOLDER, {
        vendorRef: 'us:42:fn_1',
        signingSecretEncrypted: 'sealed-vendor',
        expected,
      }),
    ).toMatchObject({ vendorRef: 'us:42:fn_1', signingSecretEncrypted: 'sealed-vendor' });

    // The generation moved on, so the same write cannot be replayed over it.
    expect(
      await writeVendorOutcome(db, endpointId, HOLDER, { vendorRef: 'stale', expected }),
    ).toBeUndefined();

    const failed = await writeVendorOutcome(db, endpointId, HOLDER, {
      vendorRef: null,
      lastError: 'PostHog refused',
      deactivate: true,
      expected: { pathToken: TOKEN, vendorRef: 'us:42:fn_1' },
    });
    expect(failed).toMatchObject({
      isActive: false,
      vendorRef: null,
      lastError: 'PostHog refused',
    });
    expect(failed?.lastErrorAt).toBeInstanceOf(Date);
    db.$client.close();
  });
});
