/**
 * Registry of live `codex app-server` clients, keyed by (cwd, credentialId).
 *
 * The app-server is a PERSISTENT process: it loads MCP + config once at startup
 * and serves many turns over JSON-RPC. Spawning one per turn would re-pay that
 * cost and lose thread state, so we spawn-on-demand and reuse across turns for
 * the same project + credential. Idle servers are torn down after a TTL so a
 * closed project doesn't hold a process forever, and a server that DIES on its
 * own (crash, OOM, kill) or whose pipe breaks (stdin EPIPE, which fires onError
 * without closing) self-evicts — otherwise the next turn would be handed a dead client.
 *
 * MCP configuration is split between spawn args and request config, while its secret values live
 * only in the child environment. A running process cannot adopt a changed environment, so the key
 * carries the caller's session, spawn args, and an unlogged digest of the effective MCP state.
 */

import type { Disposable } from 'vscode-jsonrpc/node';
import { registerCodexAppServerCountReader } from '../../diagnostics/provider-topology';
import { invalidateChannelToken } from '../../mcp/execution-identity';
import { CodexAppServerClient, type CodexAppServerClientOptions } from './app-server-client';

const IDLE_TEARDOWN_MS = 5 * 60 * 1000;

type Entry = {
  client: CodexAppServerClient;
  startPromise: Promise<unknown>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Close + transport-error self-evict subscriptions; disposed before the client. */
  subs: Disposable[];
};

const registry = new Map<string, Entry>();
registerCodexAppServerCountReader(() => registry.size);

// Components are NUL-joined so no two distinct tuples collide into one key, and no prefix can
// match partway through a component — a cwd or spawn arg containing a NUL is not a thing.
const SEP = '\u0000';

/** Every entry for a project+credential, whichever caller owns it. */
function projectPrefix(cwd: string, credentialId: string): string {
  return [credentialId, cwd].join(SEP) + SEP;
}

/** Entries sharing this prefix serve the same caller and differ only by spawn args, so a newer one
 * SUPERSEDES the older. A different prefix is a sibling (another sub-chat) and is left alone. */
function prefixFor(cwd: string, credentialId: string, sessionKey?: string): string {
  return projectPrefix(cwd, credentialId) + (sessionKey ?? '') + SEP;
}

function keyFor(
  cwd: string,
  credentialId: string,
  args: string[],
  sessionKey?: string,
  configRevision?: string,
): string {
  return prefixFor(cwd, credentialId, sessionKey) + [...args, configRevision ?? ''].join(SEP);
}

function detachEntry(key: string, entry: Entry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  for (const sub of entry.subs) sub.dispose();
  entry.subs = [];
  registry.delete(key);
}

/** Dispose timer + self-evict subscriptions + client, and drop the entry. Idempotent. */
function teardownEntry(key: string, entry: Entry): void {
  // Dispose the subs FIRST so client.dispose()'s own close/error doesn't re-enter here.
  detachEntry(key, entry);
  entry.client.dispose();
}

/** Detach synchronously like teardownEntry, while exposing the child-close barrier. */
function teardownEntryAndWait(key: string, entry: Entry): Promise<void> {
  detachEntry(key, entry);
  return entry.client.disposeAndWait();
}

function scheduleIdleTeardown(key: string): void {
  const entry = registry.get(key);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = registry.get(key);
    if (current) teardownEntry(key, current);
  }, IDLE_TEARDOWN_MS);
  // Don't keep the event loop (and thus the app) alive for an idle server.
  entry.idleTimer.unref?.();
}

/** Tear down every entry for this caller — used when its spawn args changed (the running process
 * cannot adopt them) so the superseded server exits now instead of idling to its TTL. */
function teardownPrefix(prefix: string): void {
  for (const [key, entry] of [...registry]) {
    if (key.startsWith(prefix)) teardownEntry(key, entry);
  }
}

function teardownPrefixAndWait(prefix: string): Promise<void> {
  const settlements: Promise<void>[] = [];
  for (const [key, entry] of [...registry]) {
    if (key.startsWith(prefix)) settlements.push(teardownEntryAndWait(key, entry));
  }
  return Promise.all(settlements).then(() => undefined);
}

/**
 * Get a started client for (cwd, credentialId, sessionKey, spawn args), spawning + initializing it
 * on first use. Concurrent callers share the same in-flight `start()`. Each call (re)arms the
 * idle-teardown timer so an actively-used server stays warm.
 *
 * `sessionKey` scopes reuse to one caller (pass the sub-chat's id/token when the args carry
 * caller-specific identity such as an MCP URL; omit it to share one server across callers).
 */
export async function getCodexAppServer(
  cwd: string,
  credentialId: string,
  options: CodexAppServerClientOptions,
  sessionKey?: string,
  configRevision?: string,
): Promise<CodexAppServerClient> {
  const key = keyFor(cwd, credentialId, options.args ?? [], sessionKey, configRevision);
  let entry = registry.get(key);

  if (!entry) {
    teardownPrefix(prefixFor(cwd, credentialId, sessionKey));
    const client = new CodexAppServerClient(options);
    const startPromise = client.start();
    entry = { client, startPromise, idleTimer: null, subs: [] };
    registry.set(key, entry);
    try {
      await startPromise;
      // Self-evict on crash or broken pipe (every onError source is pipe-level, never a blip) —
      // otherwise the next turn reuses a dead client until the idle TTL.
      const created = entry;
      const evict = () => {
        if (registry.get(key) === created) teardownEntry(key, created);
      };
      entry.subs.push(client.onClose(evict), client.onError(evict));
    } catch (err) {
      // A failed handshake must not leave a dead entry cached.
      client.dispose();
      registry.delete(key);
      throw err;
    }
  } else {
    await entry.startPromise;
  }

  scheduleIdleTeardown(key);
  return entry.client;
}

/**
 * Dispose one caller's server, killing any MCP call still in flight on it.
 *
 * Called when a turn is ABORTED. The server outlives the turn, so an aborted turn can leave a tool
 * call mid-flight; that call carries no turn identity, so if the next turn on this sub-chat has
 * already registered by the time it lands, the server would resolve it onto the NEW run and, for
 * `frink_task_signal`, write a superseded lifecycle signal onto it. Ending the process is what
 * makes that unrepresentable. The next turn pays a cold spawn on a fresh ephemeral thread, seeded
 * with the chat history (`freshThreadFallbackPrompt`).
 *
 * This matches by session prefix and does NOT check which client the caller owned, so it is only
 * safe from a caller that runs BEFORE the next turn for this sessionKey can spawn — i.e. inside the
 * synchronous abort listener. From a deferred/async unwind it would race that next turn and tear
 * down its server mid-startup.
 */
export function disposeCodexAppServerSession(
  cwd: string,
  credentialId: string,
  sessionKey: string,
): void {
  // sessionKey IS the sub-chat id. Retiring the channel token alongside the process closes the
  // in-flight half of the straggler window: a request already sent with the old token resolves to
  // no execution instead of the NEXT turn's context (and its permission consent).
  invalidateChannelToken(sessionKey, 'codex');
  teardownPrefix(prefixFor(cwd, credentialId, sessionKey));
}

/** Synchronously detach one caller's server and await its child-process close. */
export function disposeCodexAppServerSessionAndWait(
  cwd: string,
  credentialId: string,
  sessionKey: string,
): Promise<void> {
  invalidateChannelToken(sessionKey, 'codex');
  return teardownPrefixAndWait(prefixFor(cwd, credentialId, sessionKey));
}

/** Dispose every live server (app shutdown). */
export function disposeAllCodexAppServers(): void {
  for (const [key, entry] of [...registry]) teardownEntry(key, entry);
}

/** Live server count; aggregate-only diagnostics also read this through a registered callback. */
export function codexAppServerCount(): number {
  return registry.size;
}
