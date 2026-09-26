import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../../../shared/integrations/providers';
import { getProviderById, registersLocally } from '../../../shared/integrations/selectors';
import type { WebhookReceiverDeps } from '../../../shared/webhooks/receiver';
import {
  acquireOperation,
  findActiveWebhookEndpoint,
  findLocalIntegration,
  type LocalIntegrationRow,
  setLocalIntegrationToken,
} from '../db/repos/webhook-ingress';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { posthogRegistrar } from '../integrations/trigger-registrars/posthog';
import * as tokenCrypto from '../credentials/token-crypto';
import { fakeClickupApi, fakePosthogApi } from '../integrations/trigger-registrars/test-helpers';
import * as mcp from '../mcp';
import * as baseUrl from './base-url';
import {
  createLocalTriggerAccount,
  type LocalEndpointIo,
  type LocalEndpointView,
  mintLocalEndpoint,
  sendLocalTestEvent,
} from './local-endpoints';
import {
  importLocalVendorWebhook,
  registerLocalTrigger,
  removeLocalTrigger,
  removeLocalTriggersForAccount,
  removeLocalTriggersForProvider,
  remintForRelayMove,
  retryLocalTrigger,
  rotateLocalTrigger,
} from './local-registrars';
import { endpointRow, seal, sealedWebhookIo } from './test-utils';

type ForwardedWebhookEvent = Parameters<WebhookReceiverDeps['forwardWebhookEvent']>[0];

const BASE = 'https://ingress.test';
const MOVED = 'https://moved.test';
const THIRD = 'https://third.test';
const CLICKUP_KEY = 'pk_private';
const HF_HOOK = 'hf-hook-1';
const ENDPOINT_LIMIT = 3;

let db: TestDb;
let io: LocalEndpointIo;
let claims: number;
let forwarded: ForwardedWebhookEvent[];
let captured: unknown[];

async function account(provider: string): Promise<LocalIntegrationRow> {
  const id = await createLocalTriggerAccount(io, provider);
  const row = await findLocalIntegration(db, id);
  if (!row) throw new Error('the account row vanished');
  return row;
}

async function mint(owner: LocalIntegrationRow): Promise<LocalEndpointView> {
  const minted = await mintLocalEndpoint(io, owner, ENDPOINT_LIMIT);
  if (!minted.success) throw new Error(minted.error);
  return minted.endpoint;
}

function storedRow(endpointId: string) {
  const row = endpointRow(db, endpointId);
  if (!row) throw new Error('the endpoint row vanished');
  return row;
}

/** The chat credential the MCP-class registrars read; nothing else in this file needs a keyring. */
function grantMcpToken(token: string) {
  vi.spyOn(mcp, 'getGlobalMcpServers').mockResolvedValue({});
  vi.spyOn(mcp, 'getMcpCredentials').mockResolvedValue({ oauth: { accessToken: token } });
}

beforeEach(() => {
  vi.stubEnv('FRINK_WEBHOOK_BASE_URL', BASE);
  db = freshDb();
  claims = 0;
  forwarded = [];
  captured = [];
  io = {
    ...sealedWebhookIo(
      db,
      async (event) => {
        forwarded.push(event);
      },
      (cause) => captured.push(cause),
    ),
    claimAddresses: () => {
      claims += 1;
    },
  };
});

afterEach(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local trigger registrars', () => {
  it('serves exactly the available auto providers whose registrar runs on this machine', () => {
    expect(
      PROVIDERS.filter(registersLocally)
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(['clickup', 'cloudflare', 'huggingface', 'posthog']);
    // A launch flag that is not on hides the provider's registrar too, as it does for the paste class.
    const posthog = getProviderById('posthog');
    // SAFETY: 'retired' is deliberately not a LAUNCH_FLAGS key; every real flag is on today.
    expect(posthog && registersLocally({ ...posthog, enabled_when: ['retired' as never] })).toBe(
      false,
    );
  });

  it('refuses to arm a deactivated address again', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id);
    await expect(removeLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({ ok: true });

    await expect(registerLocalTrigger(io, owner, endpoint.id)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('not found'),
    });
    expect(storedRow(endpoint.id)).toMatchObject({ isActive: false, vendorRef: null });
    expect([...posthog.functions.values()].filter((fn) => !fn.deleted)).toHaveLength(0);
  });

  it('registers PostHog on the local address and holds the row while it does', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);

    await expect(registerLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({ ok: true });

    expect(endpoint.webhookUrl).toBe(`${BASE}/api/triggers/posthog/${endpoint.webhookPathToken}`);
    expect([...posthog.functions.values()]).toEqual([
      { name: 'Frink', url: endpoint.webhookUrl, deleted: false },
    ]);
    const row = storedRow(endpoint.id);
    expect(row.vendorRef).toBe('us:42:fn_1');
    expect(row.lastError).toBeNull();
    // The lease is handed back the moment the exchange ends.
    expect(row.operationId).toBeNull();
    expect(row.operationExpiresAt).toBeNull();
    expect(captured).toEqual([]);
  });

  it('refuses a second setup while another run holds the lease, and takes it once it expires', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await acquireOperation(db, endpoint.id, 'a-run-on-another-instance', 60_000);

    await expect(registerLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({
      ok: false,
      retryRequired: true,
      reason:
        'Another trigger operation is running, or the connection changed. Refresh and try again.',
    });
    expect(posthog.functions.size).toBe(0);

    await acquireOperation(db, endpoint.id, 'a-run-on-another-instance', -10_000);
    await expect(registerLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({ ok: true });
    expect(posthog.functions.size).toBe(1);
  });

  it('stores the ClickUp key sealed and takes the vendor secret it issues', async () => {
    const clickup = fakeClickupApi(CLICKUP_KEY);
    vi.stubGlobal('fetch', clickup.fetch);
    const owner = await account('clickup');
    const endpoint = await mint(owner);

    await expect(
      registerLocalTrigger(io, owner, endpoint.id, { apiToken: CLICKUP_KEY }),
    ).resolves.toEqual({ ok: true });

    const saved = await findLocalIntegration(db, owner.id);
    expect(saved?.apiTokenEncrypted).toBe(seal(CLICKUP_KEY));
    expect(saved?.apiTokenEncrypted).not.toBe(CLICKUP_KEY);
    const row = storedRow(endpoint.id);
    expect(JSON.parse(row.vendorRef ?? '')).toEqual({ workspaceId: '1', webhookId: 'hook-1' });
    expect(row.signingSecretEncrypted).toBe(seal('secret-1'));

    // A second, different key would silently re-point the subscription, so it is refused.
    await expect(
      registerLocalTrigger(io, owner, endpoint.id, { apiToken: 'pk_someone_else' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'Disconnect this trigger account before changing its API key.',
    });
  });

  it('sees a ClickUp key saved after the account was read', async () => {
    const clickup = fakeClickupApi(CLICKUP_KEY);
    vi.stubGlobal('fetch', clickup.fetch);
    const stale = await account('clickup');
    const endpoint = await mint(stale);
    await setLocalIntegrationToken(db, stale.id, seal(CLICKUP_KEY));
    // The stored key is read through the app's keyring; here that is the test sealer.
    vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation((value) =>
      value ? io.decryptSecret(value) : null,
    );

    await expect(registerLocalTrigger(io, stale, endpoint.id)).resolves.toEqual({ ok: true });
    expect(JSON.parse(storedRow(endpoint.id).vendorRef ?? '')).toMatchObject({ workspaceId: '1' });
  });

  it('writes an imported ClickUp webhook and its secret together, and refuses a second one', async () => {
    const owner = await account('clickup');
    const endpoint = await mint(owner);

    await expect(
      importLocalVendorWebhook(io, owner, endpoint.id, 'manual:clickup:hook-9', 'pasted-secret'),
    ).resolves.toEqual({ ok: true });

    const row = storedRow(endpoint.id);
    expect(row.vendorRef).toBe('manual:clickup:hook-9');
    expect(row.signingSecretEncrypted).toBe(seal('pasted-secret'));

    await expect(
      importLocalVendorWebhook(io, owner, endpoint.id, 'manual:clickup:hook-10', 'other'),
    ).resolves.toEqual({
      ok: false,
      reason: 'Deactivate the existing trigger before connecting another.',
    });
    expect(storedRow(endpoint.id).signingSecretEncrypted).toBe(seal('pasted-secret'));
  });

  it('retries only an address the vendor never confirmed', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);

    await expect(retryLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({ ok: true });
    expect(posthog.functions.size).toBe(1);

    posthog.requests.length = 0;
    await expect(retryLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({ ok: true });
    expect(posthog.requests).toEqual([]);
  });

  it('rotates the address and re-points the same vendor subscription at it', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id);
    const before = storedRow(endpoint.id);
    claims = 0;

    await expect(rotateLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({ ok: true });

    const after = storedRow(endpoint.id);
    expect(after.pathToken).not.toBe(before.pathToken);
    expect(after.signingSecretEncrypted).not.toBe(before.signingSecretEncrypted);
    expect(after.vendorRef).toBe('us:42:fn_1');
    expect(posthog.functions.get('fn_1')?.url).toBe(
      `${BASE}/api/triggers/posthog/${after.pathToken}`,
    );
    // The new address has to be claimed on the relay now, not at the next reconnect.
    expect(claims).toBe(1);
  });

  it('deletes the subscription at the address it was armed on, then moves the row', async () => {
    const clickup = fakeClickupApi(CLICKUP_KEY);
    vi.stubGlobal('fetch', clickup.fetch);
    vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation((value) =>
      value ? io.decryptSecret(value) : null,
    );
    const owner = await account('clickup');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id, { apiToken: CLICKUP_KEY });
    const before = storedRow(endpoint.id);
    // ClickUp refuses to touch a webhook whose destination has moved, so a removal aimed at the
    // address in force would find nothing to delete and leave the old one posting to the old relay.
    vi.spyOn(baseUrl, 'mintedAgainstBaseUrl').mockReturnValue(BASE);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED);

    await expect(remintForRelayMove(io, [], false)).resolves.toEqual([]);

    expect(clickup.mutations.at(-1)).toEqual({ method: 'DELETE', id: 'hook-1' });
    expect(clickup.hooks.size).toBe(0);
    const after = storedRow(endpoint.id);
    expect(after.vendorRef).toBeNull();
    expect(after.pathToken).not.toBe(before.pathToken);
    expect(after.signingSecretEncrypted).not.toBe(before.signingSecretEncrypted);
    expect(after.lastError).toBeNull();
  });

  it('retries a stranded row at the base it is still armed on, not the one recorded since', async () => {
    const clickup = fakeClickupApi(CLICKUP_KEY);
    vi.stubGlobal('fetch', clickup.fetch);
    vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation((value) =>
      value ? io.decryptSecret(value) : null,
    );
    const owner = await account('clickup');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id, { apiToken: CLICKUP_KEY });
    // The rows that moved are recorded on MOVED; this one never left BASE, so a removal built from
    // the record would name a destination ClickUp never had and orphan the webhook.
    vi.spyOn(baseUrl, 'mintedAgainstBaseUrl').mockReturnValue(MOVED);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED);

    await expect(
      remintForRelayMove(io, [{ id: endpoint.id, armedOn: BASE }], true),
    ).resolves.toEqual([]);

    expect(clickup.hooks.size).toBe(0);
    expect(storedRow(endpoint.id).lastError).toBeNull();
  });

  it('gives each row its own armed-on base when a later move finds an earlier one half done', async () => {
    const clickup = fakeClickupApi(CLICKUP_KEY);
    vi.stubGlobal('fetch', clickup.fetch);
    vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation((value) =>
      value ? io.decryptSecret(value) : null,
    );
    const owner = await account('clickup');
    const behind = await mint(owner);
    await registerLocalTrigger(io, owner, behind.id, { apiToken: CLICKUP_KEY });
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED);
    const ahead = await mint(owner);
    await registerLocalTrigger(io, owner, ahead.id);
    vi.spyOn(baseUrl, 'mintedAgainstBaseUrl').mockReturnValue(MOVED);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', THIRD);

    await expect(
      remintForRelayMove(io, [{ id: behind.id, armedOn: BASE }], false),
    ).resolves.toEqual([]);

    // One base for the whole move orphans whichever half is not on it.
    expect(clickup.hooks.size).toBe(0);
    expect(storedRow(behind.id).lastError).toBeNull();
    expect(storedRow(ahead.id).lastError).toBeNull();
  });

  it('takes down a subscription its registrar finds for itself, with no handle saved', async () => {
    const owner = await account('huggingface');
    const endpoint = await mint(owner);
    const hooks = new Map([[HF_HOOK, endpoint.webhookUrl]]);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${new URL(String(url)).pathname}`);
        if (method === 'DELETE') hooks.delete(HF_HOOK);
        return Response.json(
          [...hooks].map(([id, target]) => ({
            id,
            url: target,
            watched: [{ type: 'user', name: 'someone' }],
            domains: ['repo', 'discussion'],
            hasSecret: true,
            disabled: false,
          })),
        );
      }),
    );
    grantMcpToken('hf_mcp_token');
    vi.spyOn(baseUrl, 'mintedAgainstBaseUrl').mockReturnValue(BASE);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED);

    await expect(remintForRelayMove(io, [], false)).resolves.toEqual([]);

    // Frink saves no handle until this registrar's own write lands, so classifying by the handle
    // would move the row and leave a live subscription posting to the relay being left.
    expect(calls).toContain(`DELETE /api/settings/webhooks/${HF_HOOK}`);
    expect(storedRow(endpoint.id).vendorRef).toBeNull();
    expect(storedRow(endpoint.id).lastError).toBeNull();
  });

  it('moves a row the vendor would not let go of, and says what to delete by hand', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id);
    const before = storedRow(endpoint.id);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED);
    grantMcpToken('a-token-posthog-does-not-know');

    await expect(remintForRelayMove(io, [], false)).resolves.toEqual([]);

    // The relay being left was handed this row's subscribe key, so the key goes whatever the vendor
    // says; what it refused to delete is named on the card rather than left silent.
    const after = storedRow(endpoint.id);
    expect(after.pathToken).not.toBe(before.pathToken);
    expect(after.vendorRef).toBeNull();
    expect(after.lastError).toContain(posthogRegistrar.manualRemoval);
    expect(posthog.functions.get('fn_1')?.deleted).toBe(false);
  });

  it('leaves an address another operation holds untouched, and takes it on the next turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('a move must not call a vendor for a row it does not hold');
      }),
    );
    const owner = await account('clickup');
    const held = await mint(owner);
    const free = await mint(owner);
    await importLocalVendorWebhook(io, owner, held.id, 'manual:clickup:hook-9', 'pasted');
    await acquireOperation(db, held.id, 'a-setup-already-running', 60_000);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED);

    const stranded = await remintForRelayMove(io, [], false);
    const movedFirstTime = storedRow(free.id).pathToken;
    expect(stranded).toEqual([{ id: held.id, armedOn: null }]);
    // Writing through a live lease would overwrite the address and secret that setup is arming.
    expect(storedRow(held.id)).toMatchObject({
      pathToken: held.webhookPathToken,
      vendorRef: 'manual:clickup:hook-9',
    });

    await acquireOperation(db, held.id, 'a-setup-already-running', -10_000);
    await expect(remintForRelayMove(io, stranded, true)).resolves.toEqual([]);

    expect(storedRow(held.id).pathToken).not.toBe(held.webhookPathToken);
    // A row that made it the first time is on this relay already: minting it again would cost the
    // user a second paste at the vendor for an address that was never wrong.
    expect(storedRow(free.id).pathToken).toBe(movedFirstTime);
  });

  it('moves a hand-imported webhook as a paste row, so its vendor-issued secret is not kept', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('a hand-imported row has no subscription Frink can re-point');
      }),
    );
    const owner = await account('clickup');
    const endpoint = await mint(owner);
    await importLocalVendorWebhook(io, owner, endpoint.id, 'manual:clickup:hook-9', 'pasted');
    const before = storedRow(endpoint.id);
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', MOVED);

    await expect(remintForRelayMove(io, [], false)).resolves.toEqual([]);

    // Keeping the handle would leave the card listening on a secret ClickUp issued for an address
    // that no longer exists, with nothing telling the user to paste the new one back.
    const after = storedRow(endpoint.id);
    expect(after.vendorRef).toBeNull();
    expect(after.pathToken).not.toBe(before.pathToken);
    expect(after.signingSecretEncrypted).not.toBe(before.signingSecretEncrypted);
  });

  it('removes the subscription at the vendor before the address stops answering', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id);

    await expect(removeLocalTrigger(io, owner, endpoint.id)).resolves.toEqual({ ok: true });

    expect(posthog.functions.get('fn_1')?.deleted).toBe(true);
    const row = storedRow(endpoint.id);
    expect(row.isActive).toBe(false);
    expect(row.vendorRef).toBeNull();
    expect(await findActiveWebhookEndpoint(db, row.pathToken, 'posthog')).toBeNull();
  });

  it('tells the user how to remove the subscription by hand when the vendor refuses', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id);
    grantMcpToken('a-token-posthog-does-not-know');

    const result = await removeLocalTrigger(io, owner, endpoint.id);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(posthogRegistrar.manualRemoval),
    });
    expect(posthog.functions.get('fn_1')?.deleted).toBe(false);
    expect(storedRow(endpoint.id).isActive).toBe(true);
  });

  it("takes down one account's subscriptions and leaves a sibling account of the same provider alone", async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const leaving = await account('posthog');
    const staying = await account('posthog');
    const gone = await mint(leaving);
    const kept = await mint(staying);
    await registerLocalTrigger(io, leaving, gone.id);
    await registerLocalTrigger(io, staying, kept.id);

    await expect(removeLocalTriggersForAccount(io, leaving)).resolves.toEqual({ ok: true });

    expect(storedRow(gone.id).isActive).toBe(false);
    expect(storedRow(kept.id)).toMatchObject({ isActive: true, vendorRef: expect.any(String) });
    expect([...posthog.functions.values()].filter((fn) => !fn.deleted)).toHaveLength(1);
  });

  it('takes down every subscription of one provider and leaves the others alone', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id);
    const spared = await mint(await account('clickup'));

    await expect(removeLocalTriggersForProvider(io, 'posthog')).resolves.toEqual({ ok: true });

    expect(posthog.functions.get('fn_1')?.deleted).toBe(true);
    expect(storedRow(endpoint.id).isActive).toBe(false);
    expect(storedRow(spared.id).isActive).toBe(true);
  });

  it('hands back the manual step when the vendor refuses, so Remove can stop', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const endpoint = await mint(owner);
    await registerLocalTrigger(io, owner, endpoint.id);
    grantMcpToken('a-token-posthog-does-not-know');

    await expect(removeLocalTriggersForProvider(io, 'posthog')).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining(posthogRegistrar.manualRemoval),
    });
    expect(posthog.functions.get('fn_1')?.deleted).toBe(false);
    expect(storedRow(endpoint.id).isActive).toBe(true);
  });

  it('will not touch an address that belongs to another account', async () => {
    const posthog = fakePosthogApi('us');
    vi.stubGlobal('fetch', posthog.fetch);
    grantMcpToken('pha_mcp_token');
    const owner = await account('posthog');
    const stranger = await account('posthog');
    const endpoint = await mint(owner);

    await expect(registerLocalTrigger(io, stranger, endpoint.id)).resolves.toEqual({
      ok: false,
      reason: 'Active trigger not found.',
    });
    expect(posthog.functions.size).toBe(0);
    expect(storedRow(endpoint.id).operationId).toBeNull();
  });

  it('starts a Flow from a sample event with no vendor and no host reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no host is reachable in this test');
      }),
    );
    const owner = await account('posthog');
    const endpoint = await mint(owner);

    await expect(sendLocalTestEvent(io, owner, endpoint.id, 'event_matched')).resolves.toEqual({
      success: true,
      eventType: 'event_matched',
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ integrationId: owner.id });
  });
});
