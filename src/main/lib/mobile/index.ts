import { hostname } from 'node:os';
import { join } from 'node:path';
import { Mutex } from 'async-mutex';
import { app, BrowserWindow, powerMonitor } from 'electron';
import { encodeKey } from '../../../shared/lib/mobile-channel';
import { FRINK_RELAY_BASE_URL } from '../webhooks/base-url';
import { executeMobileRequest, storeMobileAttachment, subChatBusy } from './domain-api';
import { loadDesktopIdentity, resetDesktopIdentity, type DesktopIdentity } from './identity';
import { startMobileLiveActivity } from './live-activity';
import { startMobileNotifications } from './notifications';
import { MobilePairingStore } from './pairing-store';
import { startRelayHost, type RelayHost } from './relay-host';
import { createMobileApp } from './server';

let storePromise: Promise<MobilePairingStore> | null = null;
let host: { relay: string; identity: DesktopIdentity; channel: RelayHost } | null = null;
let hostError: string | null = null;
let stopNotifications: (() => void) | null = null;
let liveActivity: ReturnType<typeof startMobileLiveActivity> | null = null;
const lifecycle = new Mutex();
const identityPath = () => join(app.getPath('userData'), 'mobile-identity.json');

function getStore(): Promise<MobilePairingStore> {
  storePromise ??= (async () => {
    const store = new MobilePairingStore(join(app.getPath('userData'), 'mobile.json'));
    await store.initialize();
    return store;
  })();
  return storePromise;
}

/** Whether Frink is the app in front on an unlocked screen, and seconds since the last input
 * anywhere. An unknown state reads as out of view, so a wrong read costs an extra alert. */
export function desktopPresence(): { inView: boolean; idle: number } {
  const state = powerMonitor.getSystemIdleState(1);
  const inView = !!BrowserWindow.getFocusedWindow() && (state === 'active' || state === 'idle');
  return { inView, idle: powerMonitor.getSystemIdleTime() };
}

/** Frink's relay unless FRINK_MOBILE_RELAY_URL names a self-hosted one. Webhook ingress may be a
 * tunnel with no /mobile namespace, so it is never reused; the phone needs a bare HTTPS origin. */
function mobileRelay(): string {
  const configured = process.env.FRINK_MOBILE_RELAY_URL;
  if (configured === undefined) return FRINK_RELAY_BASE_URL;
  try {
    const url = new URL(configured.trim());
    const bare = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    if (url.protocol === 'https:' && bare) return url.origin;
  } catch {
    // Unparseable falls through to the same refusal as a non-HTTPS address.
  }
  throw new Error(
    'Mobile access needs the Frink relay. Unset FRINK_MOBILE_RELAY_URL or set it to a bare HTTPS origin.',
  );
}

async function startHost(store: MobilePairingStore): Promise<void> {
  if (host) return;
  try {
    const relay = mobileRelay();
    const identity = await loadDesktopIdentity(identityPath());
    const mobileApp = createMobileApp(store, executeMobileRequest, storeMobileAttachment);
    stopNotifications = startMobileNotifications(store, {
      desktop: desktopPresence,
      isBusy: subChatBusy,
    });
    liveActivity = startMobileLiveActivity(store);
    const channel = startRelayHost({
      relay,
      identity,
      fetch: (request) => mobileApp.fetch(request),
      authenticate: (token) => store.authenticate(token),
    });
    host = { relay, identity, channel };
    hostError = null;
  } catch (error) {
    // Nothing half-started survives a failed start.
    liveActivity?.stop();
    liveActivity = null;
    stopHost();
    hostError = error instanceof Error ? error.message : 'Mobile access could not start.';
    throw new Error(hostError);
  }
}

function stopHost(): void {
  stopNotifications?.();
  stopNotifications = null;
  host?.channel.close();
  host = null;
}

export async function initializeMobileAccess(): Promise<void> {
  await lifecycle.runExclusive(async () => {
    const store = await getStore();
    if (store.status().enabled) await startHost(store);
  });
}

export async function mobileAccessStatus() {
  const store = await getStore();
  const status = store.status();
  return {
    ...status,
    error: status.error ?? hostError,
    running: Boolean(host),
    relayConnected: host?.channel.connected() ?? false,
    machineName: hostname(),
  };
}

export async function enableMobileAccess() {
  await lifecycle.runExclusive(async () => {
    const store = await getStore();
    await store.enable();
    await startHost(store);
  });
  return mobileAccessStatus();
}

export async function stopMobileAccess(): Promise<void> {
  await lifecycle.runExclusive(async () => {
    liveActivity?.stop();
    liveActivity = null;
    stopHost();
  });
}

export async function disableMobileAccess() {
  await lifecycle.runExclusive(async () => {
    const store = await getStore();
    // The sampler ends each card from its own tokens, which the store is about to forget.
    liveActivity?.stop();
    liveActivity = null;
    try {
      await store.disable();
    } finally {
      stopHost();
      // A new identity retires every QR already shown and every key a phone pinned.
      await resetDesktopIdentity(identityPath());
    }
    hostError = null;
  });
  return mobileAccessStatus();
}

export async function createMobilePairing() {
  // Serialized with stop and disable, so a code never names an identity being torn down.
  return lifecycle.runExclusive(async () => {
    if (!host) throw new Error('Enable mobile access before pairing a phone.');
    return (await getStore()).pair({
      relay: host.relay,
      route: host.identity.route,
      key: encodeKey(host.identity.keyPair.publicKey),
      machine: hostname().slice(0, 80),
    });
  });
}

export async function revokeMobileDevice(id: string) {
  liveActivity?.endDevice(id);
  const store = await getStore();
  // The live channel closes as soon as the token is refused in memory, not after the disk write.
  await store.revoke(id, () => host?.channel.sever((token) => !store.authenticate(token)));
  return mobileAccessStatus();
}
