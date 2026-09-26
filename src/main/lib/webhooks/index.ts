import log from 'electron-log';
import { decryptToken, encryptToken } from '../credentials/token-crypto';
import { getDatabase } from '../db';
import { handleVerifiedWebhookEvent } from '../flows/webhook-trigger';
import { captureMainException } from '../sentry/init';
import {
  ingressBaseUrl,
  loadRelayMoveRecord,
  mintedAgainstBaseUrl,
  rejectedIngressEnv,
  setLoopbackIngressPort,
  setRelayMoveOutcome,
  strandedEndpoints,
} from './base-url';
import { createLocalWebhookDeps, type LocalWebhookIo, listSubscribeKeys } from './deps';
import { startWebhookListener } from './listener';
import type { LocalEndpointIo } from './local-endpoints';
import { remintForRelayMove } from './local-registrars';
import { type RelayClient, startRelayClient } from './relay-client';

export * from './local-endpoints';
export * from './local-registrars';

let relayClient: RelayClient | null = null;

function localWebhookIo(db: LocalWebhookIo['db'] = getDatabase()): LocalWebhookIo {
  return {
    db,
    encryptSecret: encryptToken,
    decryptSecret: decryptToken,
    forwardEvent: async (event) => {
      await handleVerifiedWebhookEvent(event);
    },
    captureException: captureMainException,
  };
}

/** The io every local endpoint action runs on: this machine's database and keyring, and the relay
 * claim that makes a newly minted address answerable without waiting for a reconnect. */
export function localEndpointIo(db?: LocalWebhookIo['db']): LocalEndpointIo {
  return {
    ...localWebhookIo(db),
    claimAddresses: () => relayClient?.refresh(),
  };
}

/** Relay moves run one at a time. Two at once would each re-mint against the base they read, and
 * the slower one's record would outlive the other's rows, re-minting everything again next boot. */
let moving: Promise<void> = Promise.resolve();

function serialized(run: () => Promise<void>): Promise<void> {
  moving = moving.then(run, run);
  return moving;
}

async function moveToResolvedBase(io: LocalEndpointIo): Promise<void> {
  const base = ingressBaseUrl();
  // No address at all is not a relay move: re-minting here would point every vendor at loopback.
  if (base === null) return;
  const owed = strandedEndpoints();
  const here = base === mintedAgainstBaseUrl();
  if (here && owed.length === 0) return;
  // A row an earlier turn could not take is retried until it moves; the rows that did move are on
  // this base already, so a retry turn must not cost them a second setup at their vendor.
  const stranded = await remintForRelayMove(io, owed, here);
  // The relay has to be handed the keys just minted, or no new address answers until a reconnect.
  io.claimAddresses();
  // The addresses have moved whatever the disk then says, so a record that will not write costs
  // the next boot a repeat of the move, not this one its result.
  await setRelayMoveOutcome(base, stranded).catch((error) =>
    log.warn('[WebhookIngress] could not record the relay move', { error }),
  );
}

/** The rows were minted against one relay and its operator was handed every key, so a boot that
 * resolves a different one re-mints before a single address is claimed there. */
export function remintIfRelayMoved(io: LocalEndpointIo = localEndpointIo()): Promise<void> {
  return serialized(() => moveToResolvedBase(io));
}

/** Start the loopback receiver and read what the last relay move left, so a signed delivery becomes
 * a Flow run and every address minted after this hangs off the right base. */
export async function startWebhookIngress(): Promise<number> {
  const refused = rejectedIngressEnv();
  // The only place this is ever said: nothing in the app asks for an address, so a refused
  // variable would otherwise look like a machine that simply cannot receive events.
  if (refused !== null) {
    log.warn(
      '[WebhookIngress] FRINK_WEBHOOK_BASE_URL is not an address Frink can use, so nothing on the internet can reach this computer. It has to start with https:// (or http:// for this machine only); anything after the host is ignored.',
      { value: refused },
    );
  }
  const { port } = await startWebhookListener(createLocalWebhookDeps(localWebhookIo()));
  setLoopbackIngressPort(port);
  log.info('[WebhookIngress] listening', { port });
  await serialized(loadRelayMoveRecord);
  // The move talks to every vendor in turn, so a boot that waited on it would hold first paint for
  // as long as they take, and a move that threw would cost the session its door and the rest of boot.
  void serialized(() => moveToResolvedBase(localEndpointIo())).catch((error) =>
    log.warn('[WebhookIngress] relay move failed', { error }),
  );
  return port;
}

/** Claim this machine's addresses from the relay, closing any previous claim first, so calling it
 * again moves relay. Null when no relay is named: the loopback listener is then the only door. */
export function startWebhookRelayClient(io: LocalWebhookIo = localWebhookIo()): RelayClient | null {
  relayClient?.close();
  relayClient = startRelayClient({
    subscribeKeys: () => listSubscribeKeys(io),
    deps: createLocalWebhookDeps(io),
  });
  log.info('[WebhookIngress] relay client', { configured: relayClient !== null });
  return relayClient;
}

/** What a trigger card needs to say whether anything on the internet can reach this machine. */
export type TriggerRelayStatus = {
  /** The address in use now; null when this machine has no public address. */
  baseUrl: string | null;
  /** False only once a connection this machine had is gone. No client at all has lost nothing, so
   * the seconds between a move's close and its restart are not a warning. */
  reachable: boolean;
};

export function triggerRelayStatus(): TriggerRelayStatus {
  return { baseUrl: ingressBaseUrl(), reachable: relayClient?.reachable() ?? true };
}
