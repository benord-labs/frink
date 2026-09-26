import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Mutex } from 'async-mutex';
import { shell } from 'electron';
import log from 'electron-log';
import { generateState } from '../../oauth';
import {
  getMcpCredentials,
  getGlobalMcpServers,
  removeGlobalMcpServer,
  toggleGlobalMcpEnabled,
  setGlobalMcpServer,
  updateMcpCredentialsAtomic,
} from '../config';
import { CONSENT_TIMEOUT_MS } from '../../../../shared/integrations/consent-timeouts';
import { captureMainMessage } from '../../sentry/init';
import { retireRetainedSessions } from '../../socket/claude-session-registry';
import { type FrinkMcpCredentials, vendorPluginServerConfig } from '../types';
import { hasOAuthScopes } from './mcp-auth-provider';
import { hasUsableOAuth } from './resolve-frink-servers';
import { DISCONNECTED, driveSdkConsent, type PreparedConsent } from './vendor-plugin-consent';
import { waitForCallback } from './vendor-plugin-oauth-http';
import {
  isConsentTarget,
  listConnectableVendorPluginMcp,
  type VendorOAuthTarget,
  type VendorPluginTarget,
  type VendorTokenTarget,
} from './vendor-plugin-targets';

// The targets moved to their own module; consumers and their mocks keep this path.
export {
  isConsentTarget,
  listConnectableVendorPluginMcp,
  type VendorOAuthTarget,
  type VendorTokenTarget,
} from './vendor-plugin-targets';

/** Frink-run consent for a plugin's MCP server: the SDK's auth() runs the protocol against a loopback Frink binds first. */
const CALLBACK_PATH = '/callback';
const CANCELLED = 'Authorization cancelled.';
/** The vendor's own denial code, also what a callback with our state but no code is read as. */
const DENIED = 'access_denied';

export type VendorPluginConnectResult = { serverName: string; expiresAt?: number };
export type VendorPluginConsentOutcome = { ok: boolean; error?: string; at: number };
export type VendorPluginConsentOptions = { reconnect?: boolean };

/** In-flight consents by server name: each binds one fixed port, so a second start joins the first. */
const inFlight = new Map<string, Promise<VendorPluginConnectResult>>();
/** Cancels the loopback wait of an in-flight consent, keyed by server. */
const cancels = new Map<string, () => void>();
/** Per-client singletons; a callback landing after its Disconnect sweep must not resurrect the credential. */
const generations = new Map<string, number>();
/** Outermost per-server lock: persist+register vs the Disconnect sweep never interleave; never held across the browser wait. */
const serverLocks = new Map<string, Mutex>();
function withServerLock<T>(serverName: string, work: () => Promise<T>): Promise<T> {
  let lock = serverLocks.get(serverName);
  if (!lock) {
    lock = new Mutex();
    serverLocks.set(serverName, lock);
  }
  return lock.runExclusive(work);
}
/** Last consent result per server, read back by the plugin page (main is the only channel that survives the browser round-trip). */
const outcomes = new Map<string, VendorPluginConsentOutcome>();
/** The vendor sign-in page of each in-flight consent (armed or opened), for the plugin page. */
const presenting = new Map<string, string>();

/** Register the plugin server canonically so delivery reaches every provider (idempotent). */
async function registerVendorPluginServer(target: VendorPluginTarget): Promise<void> {
  await setGlobalMcpServer(target.serverName, vendorPluginServerConfig(target.pluginName, target.url));
  retireRetainedSessions('mcp-config-change');
}

/** Recover an interrupted registration, but never move a grant to a different resource URL. */
async function reuseUsableConsent(target: VendorOAuthTarget): Promise<boolean> {
  return withServerLock(target.serverName, async () => {
    const registered = (await getGlobalMcpServers())[target.serverName];
    if (registered && registered.url !== target.url) return false;
    const credentials = await getMcpCredentials(target.serverName);
    if (!hasUsableOAuth(credentials) || !hasOAuthScopes(credentials?.oauth, target.auth.scope)) return false;
    await registerVendorPluginServer(target);
    return true;
  });
}

/** Test-only: cancels every consent and waits for its listener to release the port, then clears the maps. */
export async function resetVendorPluginMcpConsentForTests(): Promise<void> {
  for (const cancel of cancels.values()) cancel();
  await Promise.allSettled([...inFlight.values()]);
  inFlight.clear();
  cancels.clear();
  generations.clear();
  serverLocks.clear();
  outcomes.clear();
  presenting.clear();
}

export function getVendorPluginMcpConsentOutcome(
  serverName: string,
): VendorPluginConsentOutcome | undefined {
  return outcomes.get(serverName);
}

export const getVendorPluginMcpConsentUrl = (serverName: string) => presenting.get(serverName);

/** Declared targets cover pending consent; exact registrations also cover disabled and replaced packages. */
export async function ownedVendorPluginServerNames(pluginName: string): Promise<Set<string>> {
  const owned = new Set(
    (await listConnectableVendorPluginMcp())
      .filter((target) => target.pluginName === pluginName)
      .map((target) => target.serverName),
  );
  for (const [name, server] of Object.entries(await getGlobalMcpServers())) {
    if (server.managedBy === 'vendor_plugin' && server.name === `${pluginName} (plugin)`) owned.add(name);
  }
  return owned;
}

/** Cancel an attempt without revoking a grant completed before that attempt began. */
export async function cancelVendorPluginMcpConsent(pluginName: string): Promise<void> {
  for (const serverName of await ownedVendorPluginServerNames(pluginName)) {
    if (!cancels.has(serverName)) continue;
    cancels.get(serverName)?.();
    await withServerLock(serverName, async () => {
      generations.set(serverName, (generations.get(serverName) ?? 0) + 1);
      outcomes.delete(serverName);
      presenting.delete(serverName);
    });
  }
}

/** Consent for each of a plugin's servers without a usable credential, sequentially (one registered port); outcomes recorded, never thrown. */
export async function startVendorPluginMcpConsent(
  pluginName: string,
  connect: (serverName: string, options?: VendorPluginConsentOptions) => Promise<VendorPluginConnectResult> = connectVendorPluginMcp,
  options: VendorPluginConsentOptions = {},
): Promise<Record<string, VendorPluginConsentOutcome>> {
  const result: Record<string, VendorPluginConsentOutcome> = {};
  for (const target of await listConnectableVendorPluginMcp()) {
    // A token server is connected by pasting a token on the plugin page, never by a browser consent.
    if (target.pluginName !== pluginName || !isConsentTarget(target)) continue;
    const { serverName } = target;
    // Re-read + register under the lock, so a Disconnect can't be undone between them.
    const converged = !options.reconnect && await reuseUsableConsent(target);
    if (converged) {
      result[serverName] = { ok: true, at: Date.now() };
      continue;
    }
    await recordOutcome(serverName, options.reconnect ? connect(serverName, options) : connect(serverName)).catch(() => undefined);
    // A Disconnect can clear the outcome mid-flight; never emit `undefined`
    // (the renderer's success handler reads `.ok` on every value).
    result[serverName] = outcomes.get(serverName) ?? {
      ok: false,
      error: 'Chat tools were not connected.',
      at: Date.now(),
    };
  }
  return result;
}

/** Arms the tools consent for a Connect chain; `null` when nothing needs consenting. `completed` settles on
 * every terminal outcome and never rejects, and a repeat Connect supersedes the consent still on the port. */
export async function armVendorPluginMcpConsent(
  pluginName: string,
  opts: { nextHop?: string } = {},
): Promise<{ authUrl: string; completed: Promise<void> } | null> {
  const target = (await listConnectableVendorPluginMcp()).find(
    (t): t is VendorOAuthTarget => t.pluginName === pluginName && isConsentTarget(t),
  );
  if (!target) return null;
  const { serverName } = target;
  if (inFlight.has(serverName)) {
    cancels.get(serverName)?.();
    await inFlight.get(serverName)?.catch(() => undefined);
  }
  const armed = deferred<string | null>();
  // A consent that ends without ever arming (already usable, silent refresh, or a failure) settles the arm itself.
  const completed = reserve(
    serverName,
    (signal) => runConsent(target, { onArmed: armed.resolve, openNow: false, nextHop: opts.nextHop }, signal),
    Boolean(opts.nextHop),
  ).then(() => armed.resolve(null), armed.reject);
  const authUrl = await armed.promise;
  return authUrl === null ? null : { authUrl, completed };
}

/** Run the browser consent flow and persist the credential under `serverName`. Single-flight per server. */
export function connectVendorPluginMcp(serverName: string, options: VendorPluginConsentOptions = {}): Promise<VendorPluginConnectResult> {
  const existing = inFlight.get(serverName);
  if (existing) return existing;
  // Reserve synchronously; the manifest read awaits inside the reservation.
  return reserve(serverName, async (signal) => {
    const target = (await listConnectableVendorPluginMcp()).find((t) => t.serverName === serverName);
    if (!target || !isConsentTarget(target)) {
      throw new Error(`No connectable vendor plugin MCP server named "${serverName}" is staged.`);
    }
    return runConsent(target, { openNow: true, ...options }, signal);
  });
}

/** Records the consent result for the plugin page; a deliberate cancel leaves no failure behind. */
async function recordOutcome(
  serverName: string,
  pending: Promise<VendorPluginConnectResult>,
  redirected = false,
): Promise<VendorPluginConnectResult> {
  try {
    const result = await pending;
    outcomes.set(serverName, { ok: true, at: Date.now() });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === CANCELLED || message === DISCONNECTED) {
      // Deliberate teardown (user Disconnect), not a failure to report or alert.
      outcomes.delete(serverName);
    } else if (message === DENIED) {
      // The user declined at the vendor: the dialog shows it, nobody is paged.
      outcomes.set(serverName, { ok: false, error: 'Sign-in cancelled.', at: Date.now() });
    } else {
      outcomes.set(serverName, { ok: false, error: message, at: Date.now() });
      // An ignored tab times out — recorded, never alerted; every other failure is otherwise silent, so monitor it.
      if (!message.startsWith('Timed out waiting')) {
        captureMainMessage(`Vendor plugin MCP consent failed: ${message}`, 'error', {
          surface: 'vendor-plugin-mcp-consent',
          serverName,
          redirected: String(redirected),
        });
      }
    }
    log.warn(`[VendorPluginOAuth] consent ended for "${serverName}": ${message}`);
    throw error;
  }
}

/** The cancel token exists before any async work, so a Disconnect can never land in an unguarded window. */
function reserve(
  serverName: string,
  work: (signal: AbortSignal) => Promise<VendorPluginConnectResult>,
  redirected = false,
): Promise<VendorPluginConnectResult> {
  const controller = new AbortController();
  cancels.set(serverName, () => controller.abort());
  const tracked = recordOutcome(serverName, work(controller.signal), redirected).finally(() => {
    if (inFlight.get(serverName) === tracked) inFlight.delete(serverName);
    cancels.delete(serverName);
    presenting.delete(serverName);
  });
  inFlight.set(serverName, tracked);
  void tracked.catch(() => {});
  return tracked;
}

type ConsentPresentation = VendorPluginConsentOptions & { onArmed?: (authUrl: string) => void; openNow: boolean; nextHop?: string };

/** The whole consent for one server: bind the loopback, let the SDK drive, open (or arm) the page, complete. */
async function runConsent(
  target: VendorOAuthTarget,
  opts: ConsentPresentation,
  signal: AbortSignal,
): Promise<VendorPluginConnectResult> {
  const { serverName } = target;
  // Recover a persisted-but-unregistered credential — re-read + register under the lock.
  const alreadyUsable = !opts.reconnect && await reuseUsableConsent(target);
  if (alreadyUsable) return { serverName };
  const prepared = await prepareVendorPluginMcpConsent(target, signal, opts.nextHop);
  // A refreshable credential renewed silently: no browser, nothing to arm.
  if (prepared.kind === 'authorized') return prepared.result;
  await presentConsent(target, prepared, opts, signal);
  return prepared.complete();
}

/** Open the vendor consent now (Enable MCP) or hand its url to the Connect chain, which opens it. */
async function presentConsent(
  target: VendorOAuthTarget,
  prepared: Extract<PreparedConsent, { kind: 'redirect' }>,
  opts: ConsentPresentation,
  signal: AbortSignal,
): Promise<void> {
  // A Disconnect that landed after discovery must not arm a dead link or open the vendor page.
  if (signal.aborted) throw new Error(DISCONNECTED);
  presenting.set(target.serverName, prepared.authUrl);
  if (!opts.openNow) {
    log.info(`[VendorPluginOAuth] armed consent for "${target.serverName}"`);
    opts.onArmed?.(prepared.authUrl);
    return;
  }
  try {
    await shell.openExternal(prepared.authUrl);
  } catch (error) {
    // Free the registered port — there is no fallback, so a stranded listener blocks retries.
    prepared.cancel();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  const out = {} as { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
  out.promise = new Promise<T>((resolve, reject) => Object.assign(out, { resolve, reject }));
  return out;
}

/** Bind the listener FIRST so the redirect_uri the SDK registers or sends is the port actually listened on. */
async function prepareVendorPluginMcpConsent(
  target: VendorOAuthTarget,
  signal: AbortSignal,
  nextHop?: string,
): Promise<PreparedConsent> {
  // Snapshot before any await: a later Disconnect bumps the generation and fences this consent out.
  const generation = generations.get(target.serverName) ?? 0;
  const state = generateState();
  const authUrl = deferred<string>();
  // A consent that fails before the SDK hands over its authorize URL rejects it unobserved.
  void authUrl.promise.catch(() => {});
  const callback = waitForCallback(target.auth.kind === 'static_client' ? target.auth.callbackPort : 0, state, {
    timeoutMs: CONSENT_TIMEOUT_MS,
    callbackPath: CALLBACK_PATH,
    cancelledMessage: CANCELLED,
    nextHop,
  });
  signal.addEventListener('abort', callback.cancel, { once: true });
  if (signal.aborted) callback.cancel();
  try {
    const port = await callback.port;
    return await driveSdkConsent({
      target,
      port,
      state,
      callback,
      authUrl,
      fenced: () => signal.aborted || (generations.get(target.serverName) ?? 0) !== generation,
      persist: (tokens, clientId, inherited) => persistConsent(target, generation, tokens, clientId, inherited),
    });
  } catch (error) {
    // Discovery, registration or a busy port must never strand a listener.
    authUrl.reject(error instanceof Error ? error : new Error(String(error)));
    callback.cancel();
    throw error;
  }
}

/** Persist the tokens with the client id they were minted for, then register canonically — all under the server lock. */
async function persistConsent(
  target: VendorOAuthTarget,
  generation: number,
  tokens: OAuthTokens,
  clientId: string,
  previousRefreshToken: string | undefined,
): Promise<VendorPluginConnectResult> {
  const { serverName } = target;
  const expiresAt = tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined;
  // A refresh that rotates nothing keeps the previous refresh token (RFC 6749 §6).
  const refreshToken = tokens.refresh_token ?? previousRefreshToken;
  await withServerLock(serverName, async () => {
    let discarded = false;
    await updateMcpCredentialsAtomic(async (file) => {
      // A consent can outlive its plugin: re-verify name + url + auth and the generation under the mutex.
      const current = (await listConnectableVendorPluginMcp()).find((t) => t.serverName === serverName);
      if (
        !current ||
        current.url !== target.url ||
        JSON.stringify(current.auth) !== JSON.stringify(target.auth) ||
        (generations.get(serverName) ?? 0) !== generation
      ) {
        discarded = true;
        return file;
      }
      file.servers[serverName] = {
        oauth: { accessToken: tokens.access_token, refreshToken, clientId, expiresAt, scope: tokens.scope ?? target.auth.scope },
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      };
      return file;
    });
    if (discarded) throw new Error(DISCONNECTED);
    // Registration takes the config + credential mutexes itself: outside the updater, inside the server lock.
    await registerVendorPluginServer(target);
  });
  // Token shape is the delivery contract (absent expiry reads as eternal); metadata only, never the token.
  log.info(
    `[VendorPluginOAuth] connected "${serverName}" expiresAt=${expiresAt ?? 'none'} refreshToken=${refreshToken ? 'yes' : 'no'}`,
  );
  return { serverName, expiresAt };
}

/** Store a credential for a plugin server and register it, under the server lock so a Disconnect sweep never interleaves. */
async function persistCredential(target: VendorPluginTarget, credential: FrinkMcpCredentials): Promise<void> {
  await withServerLock(target.serverName, async () => {
    await updateMcpCredentialsAtomic((file) => {
      file.servers[target.serverName] = credential;
      return file;
    });
    await registerVendorPluginServer(target);
  });
}

/** Store a user-pasted bearer for a token server and register it; the caller has validated the token. */
export function persistUserToken(target: VendorTokenTarget, token: string): Promise<void> {
  return persistCredential(target, { headers: { Authorization: `Bearer ${token}` } });
}

/** Registers the account token as the plugin's OAuth-declared MCP credential, stored as a never-expiring
 * grant so the status and delivery classifiers read it like a consent Frink ran itself. */
export async function persistAccountCredential(pluginName: string, accessToken: string): Promise<void> {
  const target = (await listConnectableVendorPluginMcp()).find(
    (t): t is VendorOAuthTarget => t.pluginName === pluginName && isConsentTarget(t),
  );
  if (!target) throw new Error(`No OAuth plugin MCP server is declared for "${pluginName}".`);
  await persistCredential(target, {
    oauth: { accessToken },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  log.info(`[VendorPluginOAuth] registered "${target.serverName}" from the account grant`);
}

/** Mirrors the plugin's on/off state onto its registered chat-MCP delivery — the credential stays, so re-enable needs no consent. */
export async function setVendorPluginMcpDeliveryEnabled(
  pluginName: string,
  enabled: boolean,
): Promise<void> {
  for (const serverName of await ownedVendorPluginServerNames(pluginName)) {
    await toggleGlobalMcpEnabled(serverName, enabled);
    retireRetainedSessions('mcp-config-change');
  }
}

/**
 * Sweep the stored credentials for a plugin's own declared servers, so an
 * uninstalled plugin leaves no live user token on disk. Resolved to EXACT
 * names from the declarations, never a `plugin_<name>_` prefix: that prefix
 * also matches another plugin's servers (uninstalling `foo` would delete
 * `foo_bar`'s credentials) — the same ambiguity the delivery path fails
 * closed on. Exact managed registrations keep cleanup available when the
 * package is disabled, missing, or replaced.
 */
export async function removeVendorPluginMcpCredentials(pluginName: string): Promise<string[]> {
  const owned = await ownedVendorPluginServerNames(pluginName);
  const removed: string[] = [];
  // Cancel the browser wait OUTSIDE the lock (a completion may hold it); the
  // cancelled consent then settles as DISCONNECTED without persisting.
  for (const name of owned) {
    cancels.get(name)?.();
    presenting.delete(name);
  }
  for (const name of owned) {
    // Under the server lock, so no completion's persist+register interleaves:
    // fence the generation, delete the credential, deregister — atomically.
    await withServerLock(name, async () => {
      generations.set(name, (generations.get(name) ?? 0) + 1);
      outcomes.delete(name);
      await updateMcpCredentialsAtomic((file) => {
        if (file.servers[name]) {
          delete file.servers[name];
          removed.push(name);
        }
        return file;
      });
      await removeGlobalMcpServer(name);
    });
    retireRetainedSessions('mcp-config-change');
  }
  if (removed.length > 0) {
    log.info(`[VendorPluginOAuth] removed credentials: ${removed.join(', ')}`);
  }
  return removed;
}
