import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Mutex } from 'async-mutex';
import { app } from 'electron';
import log from 'electron-log';
import { MOBILE_PORT } from '../../../shared/types/remote/mobile';
import { executeMobileRequest } from './domain-api';
import { MobilePairingStore } from './pairing-store';
import { startMobileServer, stopMobileServer } from './server';

let storePromise: Promise<MobilePairingStore> | null = null;
let server: Server | null = null;
let serverError: string | null = null;
const lifecycle = new Mutex();

function getStore(): Promise<MobilePairingStore> {
  storePromise ??= (async () => {
    const store = new MobilePairingStore(join(app.getPath('userData'), 'mobile.json'));
    await store.initialize();
    return store;
  })();
  return storePromise;
}

async function startServer(store: MobilePairingStore): Promise<void> {
  if (server) return;
  try {
    server = await startMobileServer(store, executeMobileRequest);
    serverError = null;
  } catch {
    serverError = `Mobile access could not start on port ${MOBILE_PORT}. Close any other Frink instance using it, then try again.`;
    throw new Error(serverError);
  }
}

export async function initializeMobileAccess(): Promise<void> {
  await lifecycle.runExclusive(async () => {
    const store = await getStore();
    if (store.status().enabled) await startServer(store);
  });
}

export async function mobileAccessStatus() {
  const store = await getStore();
  const status = store.status();
  return {
    ...status,
    error: status.error ?? serverError,
    running: Boolean(server),
    port: MOBILE_PORT,
    machineName: hostname(),
  };
}

export async function enableMobileAccess() {
  await lifecycle.runExclusive(async () => {
    const store = await getStore();
    await store.enable();
    await startServer(store);
  });
  return mobileAccessStatus();
}

export async function stopMobileAccess(): Promise<void> {
  await lifecycle.runExclusive(async () => {
    if (!server) return;
    const current = server;
    server = null;
    try {
      await stopMobileServer(current);
    } catch (error) {
      log.warn('[Mobile] Listener shutdown failed:', error);
    }
  });
}

export async function disableMobileAccess() {
  await lifecycle.runExclusive(async () => {
    const store = await getStore();
    try {
      await store.disable();
    } finally {
      if (server) {
        const current = server;
        server = null;
        await stopMobileServer(current);
      }
    }
    serverError = null;
  });
  return mobileAccessStatus();
}

export async function createMobilePairing(url: string) {
  if (!server) throw new Error('Enable mobile access before pairing a phone.');
  return (await getStore()).pair(url);
}

export async function revokeMobileDevice(id: string) {
  await (await getStore()).revoke(id);
  return mobileAccessStatus();
}
