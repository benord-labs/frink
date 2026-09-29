/** The `auto` class arms its own subscription from this machine. The registrars keep their vendor
 * logic untouched; what is local is the endpoint row, the lease over it and the address's base. */

import crypto from 'node:crypto';
import log from 'electron-log';
import {
  getProviderById,
  isTriggerRegistrationComplete,
  registersLocally,
} from '../../../shared/integrations/selectors';
import type { Provider } from '../../../shared/integrations/types';
import {
  acquireOperation,
  findWebhookEndpoint,
  listActiveWebhookEndpoints,
  listLocalIntegrations,
  listWebhookEndpointsForIntegration,
  type LocalIntegrationRow,
  type LocalWebhookRow,
  OPERATION_LEASE_TTL_MS,
  releaseOperation,
  renewOperation,
  rotateWebhookEndpointKeys,
  setLocalIntegrationToken,
  type VendorOutcome,
  writeVendorOutcome,
  findLocalIntegration,
} from '../db/repos/webhook-ingress';
import {
  getTriggerSetupOptions,
  mainRegistrar,
  type MainRegistrar,
  type RegistrarContext,
  type RegistrationResult,
  type TriggerRegistrar,
  type TriggerSetupOptions,
} from '../integrations/trigger-registrars';
import { readToken } from '../integrations/trigger-registrars/credentials';
import {
  triggerOperationRequiresRetry,
  withOperationScope,
} from '../integrations/trigger-registrars/operation';
import { VendorRequestError } from '../integrations/trigger-registrars/vendor-http';
import { webhookUrlOn } from '../integrations/trigger-registrars/webhook-url';
import { localIngressBaseUrl, mintedAgainstBaseUrl, type StrandedEndpoint } from './base-url';
import { readSealedSecret } from './deps';
import { type LocalEndpointIo, mintEndpointKeys } from './local-endpoints';

const BUSY =
  'Another trigger operation is running, or the connection changed. Refresh and try again.';
const CHANGED = 'Trigger setup changed. Refresh and try again.';
const KEY_IS_FIXED = 'Disconnect this trigger account before changing its API key.';
const SECRET_UNREADABLE = 'The saved secret for this address cannot be read on this machine';
const MANUAL_FIRST = 'Deactivate the manual trigger before automatic setup.';
const ENDPOINT_MISSING = 'Active trigger not found.';

type Exchange = {
  io: LocalEndpointIo;
  account: LocalIntegrationRow;
  provider: Provider;
  main: MainRegistrar;
  operationId: string;
  row: LocalWebhookRow;
  apiToken?: string;
};

type VendorWrite = (outcome: Omit<VendorOutcome, 'expected'>) => Promise<void>;

/** The adapter this machine runs for the account, or null when its class is served elsewhere. */
export function localRegistrar(account: { provider: string }): MainRegistrar | null {
  const provider = getProviderById(account.provider);
  return registersLocally(provider) ? mainRegistrar(provider) : null;
}

/** The vendor's own choices, read with the credential this machine already holds. */
export function localTriggerOptions(
  account: LocalIntegrationRow,
  apiToken?: string,
): Promise<TriggerSetupOptions> {
  return getTriggerSetupOptions(
    { provider: account.provider, api_token_encrypted: account.apiTokenEncrypted },
    apiToken,
  );
}

/** Hold the row's lease across the vendor round trips, as the hosted route's lease did. */
async function underLease(
  io: LocalEndpointIo,
  account: LocalIntegrationRow,
  endpointId: string,
  run: (exchange: Exchange) => Promise<RegistrationResult>,
): Promise<RegistrationResult> {
  const provider = getProviderById(account.provider);
  const main = localRegistrar(account);
  if (!provider || !main) return { ok: true };
  // The lease is keyed on the endpoint alone, so the account must be shown to own it first.
  if (!(await findWebhookEndpoint(io.db, account.id, endpointId)))
    return { ok: false, reason: ENDPOINT_MISSING };
  const operationId = crypto.randomUUID();
  const row = await acquireOperation(io.db, endpointId, operationId, OPERATION_LEASE_TTL_MS);
  if (!row) return { ok: false, reason: BUSY, retryRequired: true };
  try {
    // The account is re-read under the lease, so a key saved a moment ago is what this exchange sees.
    const current = await findLocalIntegration(io.db, account.id);
    if (!current) return { ok: false, reason: ENDPOINT_MISSING };
    const renew = () => renewOperation(io.db, endpointId, operationId, OPERATION_LEASE_TTL_MS);
    return await withOperationScope({ operationId, renew }, () =>
      run({ io, account: current, provider, main, operationId, row }),
    );
  } finally {
    await releaseOperation(io.db, endpointId, operationId);
  }
}

/** What the registrar reads: the row as the exchange found it, and the credential this machine
 * holds. `baseUrl` overrides the base in force, so a removal can name the address armed earlier. */
async function registrarContext(
  exchange: Exchange,
  write: VendorWrite | undefined,
  extras: { selection?: string[]; baseUrl?: string | null },
): Promise<RegistrarContext> {
  const { io, provider, row } = exchange;
  const secret = readSealedSecret(io, row.signingSecretEncrypted);
  if (!secret) throw new VendorRequestError(SECRET_UNREADABLE, 'unreadable local secret');
  return {
    provider,
    integration: { id: exchange.account.id, external_workspace_id: null },
    endpoint: { id: row.id, webhook_secret: secret, vendor_ref: row.vendorRef },
    webhookUrl: webhookUrlOn(extras.baseUrl ?? localIngressBaseUrl(), provider.id, row.pathToken),
    token:
      exchange.apiToken ??
      (await readToken(
        provider,
        { api_token_encrypted: exchange.account.apiTokenEncrypted },
        exchange.main.credential,
        exchange.main.mcpServerId,
      )),
    selection: extras.selection,
    saveProgress: write && ((ref) => write({ vendorRef: `pending:${ref}` })),
  };
}

/** Whether the vendor may still be holding a subscription for this row: a handle Frink saved, or a
 * registrar that finds its own with a credential it can read. A `manual:` handle is the user's own. */
function vendorMayHoldSubscription(main: MainRegistrar, vendorRef: string | null): boolean {
  if (vendorRef?.startsWith('manual:')) return false;
  const discovers = main.registrar.canDiscoverSubscriptions === true;
  return Boolean(vendorRef) || (discovers && main.credential !== 'api_token');
}

/** The line a user acts on when Frink's own removal did not land: what failed, and what to delete. */
function manualRemovalNote(name: string, registrar: TriggerRegistrar, reason?: string): string {
  return `Frink couldn't remove its webhook from ${name}:${reason ? ` ${reason}` : ''} ${registrar.manualRemoval}`;
}

/** Run the registrar, and keep every write on the generation the exchange started from. */
async function vendorRun(
  exchange: Exchange,
  selection: string[] | undefined,
  run: (ctx: RegistrarContext, write: VendorWrite) => Promise<void>,
): Promise<RegistrationResult> {
  const { io, provider, operationId } = exchange;
  let current = exchange.row;
  const write: VendorWrite = async (outcome) => {
    const saved = await writeVendorOutcome(io.db, current.id, operationId, {
      ...outcome,
      expected: { pathToken: current.pathToken, vendorRef: current.vendorRef },
    });
    if (!saved) throw new VendorRequestError(CHANGED, 'the local endpoint row moved on');
    current = saved;
  };
  try {
    await run(await registrarContext(exchange, write, { selection }), write);
    return { ok: true };
  } catch (error) {
    const cause = error instanceof Error ? error : String(error);
    const failure =
      error instanceof VendorRequestError
        ? error
        : new VendorRequestError(
            `Something went wrong talking to ${provider.display_name}.`,
            String(cause),
          );
    io.captureException(cause, { surface: 'local-trigger-registrar', provider: provider.id });
    await writeVendorOutcome(io.db, current.id, operationId, {
      vendorRef: current.vendorRef,
      lastError: failure.reason,
      expected: { pathToken: current.pathToken, vendorRef: current.vendorRef },
    });
    const retryRequired = triggerOperationRequiresRetry(cause);
    return retryRequired
      ? { ok: false, retryRequired, reason: failure.reason }
      : { ok: false, reason: failure.reason };
  }
}

/** The account owns one immutable key, as hosted: the same key again is a no-op. */
async function saveLocalToken(exchange: Exchange, token: string): Promise<RegistrationResult> {
  const { io, account } = exchange;
  if (exchange.main.credential !== 'api_token')
    return { ok: false, reason: 'This trigger does not use an API key.' };
  if (account.apiTokenEncrypted)
    return readSealedSecret(io, account.apiTokenEncrypted) === token
      ? { ok: true }
      : { ok: false, reason: KEY_IS_FIXED };
  if (exchange.row.vendorRef) return { ok: false, reason: KEY_IS_FIXED };
  if (!(await setLocalIntegrationToken(io.db, account.id, io.encryptSecret(token))))
    return { ok: false, reason: KEY_IS_FIXED };
  exchange.apiToken = token;
  return { ok: true };
}

/** Register the account's endpoint at the vendor; a failure leaves the row for the paste fallback. */
export function registerLocalTrigger(
  io: LocalEndpointIo,
  account: LocalIntegrationRow,
  endpointId: string,
  options: { selection?: string[]; apiToken?: string } = {},
): Promise<RegistrationResult> {
  return underLease(io, account, endpointId, async (exchange) => {
    // A row that was switched off stays off: nothing re-arms the vendor behind a deactivated address.
    if (!exchange.row.isActive) return { ok: false, reason: ENDPOINT_MISSING };
    if (exchange.row.vendorRef?.startsWith('manual:clickup:'))
      return options.apiToken ? { ok: false, reason: MANUAL_FIRST } : { ok: true };
    if (
      exchange.main.credential === 'api_token' &&
      !options.apiToken &&
      !exchange.account.apiTokenEncrypted
    )
      return { ok: true };
    if (options.apiToken) {
      const saved = await saveLocalToken(exchange, options.apiToken);
      if (!saved.ok) return saved;
    }
    return vendorRun(exchange, options.selection, async (ctx, write) => {
      const { vendorRef, secret } = await exchange.main.registrar.register(ctx);
      await write({
        vendorRef,
        signingSecretEncrypted: secret ? io.encryptSecret(secret) : undefined,
        lastError: null,
      });
    });
  });
}

/** Try the vendor again, but only where it never confirmed the subscription. */
export async function retryLocalTrigger(
  io: LocalEndpointIo,
  account: LocalIntegrationRow,
  endpointId: string,
): Promise<RegistrationResult> {
  const row = await findWebhookEndpoint(io.db, account.id, endpointId);
  if (!row?.isActive) return { ok: false, reason: ENDPOINT_MISSING };
  if (isTriggerRegistrationComplete(row.vendorRef)) return { ok: true };
  return registerLocalTrigger(io, account, endpointId);
}

/** A new address and secret where Frink owns the key, then the vendor is re-pointed at them. */
export function rotateLocalTrigger(
  io: LocalEndpointIo,
  account: LocalIntegrationRow,
  endpointId: string,
): Promise<RegistrationResult> {
  return underLease(io, account, endpointId, async (exchange) => {
    if (!exchange.row.isActive) return { ok: false, reason: ENDPOINT_MISSING };
    if (!exchange.main.registrar.issuesSigningSecret) {
      const rotated = await rotateWebhookEndpointKeys(
        io.db,
        endpointId,
        exchange.row.pathToken,
        mintEndpointKeys(io),
        true,
      );
      if (!rotated) return { ok: false, reason: CHANGED };
      exchange.row = rotated;
      io.claimAddresses();
    }
    if (!exchange.row.vendorRef) return { ok: true };
    return vendorRun(exchange, undefined, async (ctx, write) => {
      const { vendorRef, secret } = await exchange.main.registrar.rotate(ctx);
      await write({
        vendorRef: vendorRef ?? ctx.endpoint.vendor_ref,
        signingSecretEncrypted: secret ? io.encryptSecret(secret) : undefined,
        lastError: null,
      });
    });
  });
}

/** Delete the subscription this machine armed, at `armedOn`, the address it was armed on: a
 * registrar that finds its webhook pointed elsewhere refuses it. A refusal is a card line, not a stop. */
async function deregisterMoved(exchange: Exchange, armedOn: string | null): Promise<string | null> {
  const { io, main, provider, operationId, row } = exchange;
  const renew = () => renewOperation(io.db, row.id, operationId, OPERATION_LEASE_TTL_MS);
  try {
    const ctx = await registrarContext(exchange, undefined, { baseUrl: armedOn });
    await withOperationScope({ operationId, renew }, () => main.registrar.remove(ctx));
    return null;
  } catch (error) {
    io.captureException(error instanceof Error ? error : String(error), {
      surface: 'local-trigger-relay-move',
      provider: provider.id,
    });
    return manualRemovalNote(provider.display_name, main.registrar);
  }
}

/** Move one address onto the relay in use now, under the row's lease: the subscription comes down
 * first, then the row takes new keys and loses its handle. A held row is left for the next turn. */
async function moveOneAddress(
  io: LocalEndpointIo,
  account: LocalIntegrationRow | undefined,
  endpointId: string,
  armedOn: string | null,
): Promise<boolean> {
  const operationId = crypto.randomUUID();
  const row = await acquireOperation(io.db, endpointId, operationId, OPERATION_LEASE_TTL_MS);
  if (!row) return false;
  try {
    const provider = account && getProviderById(account.provider);
    const main = account && localRegistrar(account);
    const lastError =
      account && provider && main && vendorMayHoldSubscription(main, row.vendorRef)
        ? await deregisterMoved({ io, account, provider, main, operationId, row }, armedOn)
        : null;
    const moved = await writeVendorOutcome(io.db, endpointId, operationId, {
      vendorRef: null,
      keys: mintEndpointKeys(io),
      lastError,
      expected: { pathToken: row.pathToken, vendorRef: row.vendorRef },
    });
    return moved !== undefined;
  } finally {
    await releaseOperation(io.db, endpointId, operationId);
  }
}

type MovableRow = { id: string; integrationId: string };

function selected<Row extends { id: string }>(
  rows: Row[],
  only: readonly string[] | undefined,
): Row[] {
  return only ? rows.filter((row) => only.includes(row.id)) : rows;
}

async function moveEach(
  io: LocalEndpointIo,
  accounts: Map<string, LocalIntegrationRow>,
  rows: ReadonlyArray<MovableRow>,
  armedOn: (endpointId: string) => string | null,
): Promise<StrandedEndpoint[]> {
  const missed: StrandedEndpoint[] = [];
  for (const row of rows)
    if (!(await moveOneAddress(io, accounts.get(row.integrationId), row.id, armedOn(row.id))))
      missed.push({ id: row.id, armedOn: armedOn(row.id) });
  return missed;
}

/** A move re-mints every address, so the key the old relay holds claims nothing here again. `owed`
 * is what an earlier move left behind, with the base each is armed on; `onlyOwed` re-drives those. */
export async function remintForRelayMove(
  io: LocalEndpointIo,
  owed: readonly StrandedEndpoint[],
  onlyOwed: boolean,
): Promise<StrandedEndpoint[]> {
  const accounts = new Map(
    (await listLocalIntegrations(io.db)).map((account) => [account.id, account]),
  );
  const held = new Map(owed.map(({ id, armedOn }) => [id, armedOn]));
  // A row still owed a move never moved off the base it was stranded on, whatever has been recorded
  // as current since; every other row is on that record.
  const armedOn = (id: string) => held.get(id) ?? mintedAgainstBaseUrl();
  const rows = selected(
    await listActiveWebhookEndpoints(io.db),
    onlyOwed ? owed.map(({ id }) => id) : undefined,
  );
  const missed = await moveEach(io, accounts, rows, armedOn);
  if (missed.length === 0) return [];
  // A row another operation held, or one someone else rotated mid-move: re-read and try once more.
  // Anything still behind keeps a key the old relay holds, so name it rather than report a move.
  const ids = missed.map(({ id }) => id);
  const again = selected(await listActiveWebhookEndpoints(io.db), ids);
  const stranded = await moveEach(io, accounts, again, armedOn);
  if (stranded.length > 0)
    log.warn('[WebhookIngress] addresses left on the old relay', {
      endpointIds: stranded.map(({ id }) => id),
    });
  return stranded;
}

/** Delete the subscription at the vendor, then stop answering for the address here. */
export async function removeLocalTrigger(
  io: LocalEndpointIo,
  account: LocalIntegrationRow,
  endpointId: string,
): Promise<RegistrationResult> {
  const registrar = localRegistrar(account)?.registrar;
  const result = await underLease(io, account, endpointId, (exchange) =>
    vendorRun(exchange, undefined, async (ctx, write) => {
      if (vendorMayHoldSubscription(exchange.main, ctx.endpoint.vendor_ref))
        await exchange.main.registrar.remove(ctx);
      await write({ vendorRef: null, lastError: null, deactivate: true });
    }),
  );
  if (result.ok || !registrar || result.reason === BUSY) return result;
  const name = getProviderById(account.provider)?.display_name ?? account.provider;
  return { ...result, reason: manualRemovalNote(name, registrar, result.reason) };
}

/** Every subscription this machine armed for one provider, taken down while its credential is
 * still there. A discovery registrar re-checks rows it has already stopped answering for. */
/** Every subscription one account holds at the vendor; a registrar that lists its own is asked about inactive rows too. */
export async function removeLocalTriggersForAccount(
  io: LocalEndpointIo,
  account: LocalIntegrationRow,
): Promise<RegistrationResult> {
  const main = localRegistrar(account);
  if (!main) return { ok: true };
  const reasons: string[] = [];
  for (const row of await listWebhookEndpointsForIntegration(io.db, account.id)) {
    if (!row.isActive && main.registrar.canDiscoverSubscriptions !== true) continue;
    const result = await removeLocalTrigger(io, account, row.id);
    if (!result.ok) reasons.push(result.reason);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join(' ') };
}

export async function removeLocalTriggersForProvider(
  io: LocalEndpointIo,
  providerId: string,
): Promise<RegistrationResult> {
  const reasons: string[] = [];
  for (const account of await listLocalIntegrations(io.db)) {
    if (account.provider !== providerId) continue;
    const result = await removeLocalTriggersForAccount(io, account);
    if (!result.ok) reasons.push(result.reason);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join(' ') };
}

/** A webhook the user made at the vendor: its handle and its key land in one write, no call out. */
export function importLocalVendorWebhook(
  io: LocalEndpointIo,
  account: LocalIntegrationRow,
  endpointId: string,
  vendorRef: string,
  secret: string,
): Promise<RegistrationResult> {
  return underLease(io, account, endpointId, async ({ row, operationId }) => {
    if (!row.isActive) return { ok: false, reason: ENDPOINT_MISSING };
    if (row.vendorRef && row.vendorRef !== vendorRef)
      return { ok: false, reason: 'Deactivate the existing trigger before connecting another.' };
    const saved = await writeVendorOutcome(io.db, endpointId, operationId, {
      vendorRef,
      signingSecretEncrypted: io.encryptSecret(secret),
      lastError: null,
      expected: { pathToken: row.pathToken, vendorRef: row.vendorRef },
    });
    return saved ? { ok: true } : { ok: false, reason: CHANGED };
  });
}
