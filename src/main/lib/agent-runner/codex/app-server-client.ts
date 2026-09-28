/**
 * Thin typed JSON-RPC client over a spawned `codex app-server` process.
 *
 * Transport: `codex app-server` frames messages as NEWLINE-DELIMITED JSON over
 * stdio (verified in the codex protocol source + t3code's protocol.ts — NOT the
 * Content-Length framing vscode-jsonrpc's StreamMessageReader defaults to).
 * Codex also omits the `jsonrpc: "2.0"` field (jsonrpc_lite.rs); its structs are
 * not `deny_unknown_fields`, so the field vscode-jsonrpc adds on the way OUT is
 * tolerated, and we inject it on the way IN so the connection can route.
 *
 * We reuse vscode-jsonrpc (already a dep) for request/response correlation,
 * server→client request handling (approvals), and notification dispatch — only
 * the framing is custom (rule #6: don't hand-roll a correlator).
 *
 * ONE app-server process serves MANY concurrent turns (Frink's parallel-agents /
 * multi-pane use case), all over this single connection. vscode-jsonrpc allows
 * only ONE handler per method, so a turn cannot own `onNotification`/`onRequest`
 * directly — a second turn would clobber it. Instead the client installs ONE
 * router per method and demultiplexes by `threadId` (every codex notification +
 * approval carries it): `forThread(threadId)` hands a turn its own scoped
 * subscription. Notifications fan out to every subscription on the thread (each
 * filtered to its bound `turnId`); approval requests route to the single matching
 * turn (one response per request). `onClose`/`onError` stay connection-level —
 * they are vscode-jsonrpc multi-listener Events, so every live turn sees a crash.
 */

import type { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import log from 'electron-log';
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection,
  type MessageReader,
  type MessageWriter,
} from 'vscode-jsonrpc/node';
import { captureMainException } from '../../sentry/init';
import { createChildProcessCloseBarrier } from '../process-settlement';
import { APPROVAL_REQUEST_METHODS, declineApprovalResponse } from './codex-events';
import { recordCodexSkillRootsRpcOutcome } from './skill-roots';
import {
  FRINK_HOST_TOOL_PERMISSION_METHOD,
  FRINK_HOST_TOOL_PERMISSION_VERSION,
} from './codex-host-permissions';

/** Strips a trailing CR so CRLF-framed lines parse (hoisted per biome useTopLevelRegex). */
const TRAILING_CR = /\r$/;

/** Reads newline-delimited JSON from the child's stdout, one Message per line. */
class NewlineMessageReader extends AbstractMessageReader implements MessageReader {
  private buffer = '';
  private callback: DataCallback | null = null;

  constructor(private readonly stream: Readable) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    const onData = (chunk: Buffer) => this.onChunk(chunk.toString('utf8'));
    const onError = (err: Error) => this.fireError(err);
    const onClose = () => this.fireClose();
    this.stream.on('data', onData);
    this.stream.on('error', onError);
    this.stream.on('end', onClose);
    return {
      dispose: () => {
        this.stream.off('data', onData);
        this.stream.off('error', onError);
        this.stream.off('end', onClose);
      },
    };
  }

  private onChunk(text: string): void {
    this.buffer += text;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).replace(TRAILING_CR, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length > 0) this.dispatch(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    if (!this.callback) return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // Codex omits jsonrpc; vscode-jsonrpc routes on it being present.
      if (parsed.jsonrpc === undefined) parsed.jsonrpc = '2.0';
      this.callback(parsed as Message);
    } catch (err) {
      // NDJSON: an unparseable line is garbage, not a partial Content-Length frame
      // (firePartialMessage is the wrong signal here) — drop it and keep reading.
      log.warn('[Codex app-server] Failed to parse wire line', err);
    }
  }
}

/** Writes Messages as newline-delimited JSON to the child's stdin. */
class NewlineMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private errorCount = 0;

  constructor(private readonly stream: Writable) {
    super();
  }

  async write(msg: Message): Promise<void> {
    try {
      this.stream.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.errorCount++;
      this.fireError(err instanceof Error ? err : new Error(String(err)), msg, this.errorCount);
      throw err;
    }
  }

  end(): void {
    // stdin stays open for the lifetime of the persistent app-server.
  }

  /** Surface an async stream error (e.g. stdin EPIPE) that write() could not catch. */
  reportStreamError(err: Error): void {
    this.errorCount++;
    this.fireError(err, undefined, this.errorCount);
  }
}

export type CodexInitializeResult = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  capabilities?: {
    frinkHostToolPermission?: number;
  };
};

export type CodexAppServerClientOptions = {
  binary: string;
  /** Extra args after `app-server` (e.g. `--config mcp_servers.*` for MCP injection). */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** clientInfo for the initialize handshake. */
  clientInfo: { name: string; version: string; title?: string };
  /** Vendor-plugin skill roots to register via `skills/extraRoots/set` at start. */
  extraSkillRoots?: string[];
};

/** Hard cap on the initialize handshake so a hung/wrong binary can't wedge a turn forever. */
const INITIALIZE_TIMEOUT_MS = 30_000;
const DISPOSAL_FORCE_KILL_DELAY_MS = 3_000;
const DISPOSAL_TIMEOUT_MS = 4_000;

type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

/** A turn's per-method handlers on a shared client, scoped to one threadId. */
type SubState = {
  threadId: string;
  /** Bound once the turn's id is known; null until then. The router filters by it. */
  turnId: string | null;
  awaitingTurnStart: boolean;
  notif: Map<string, NotificationHandler>;
  request: Map<string, RequestHandler>;
};

/**
 * A turn's scoped view of a shared {@link CodexAppServerClient}. Register stream
 * notifications + approval requests here instead of on the client directly, so two
 * concurrent turns on one client never clobber each other. Call {@link bindTurn}
 * once the turn id is known so same-thread turns (one conversation in two panes)
 * can't cross-deliver; {@link dispose} drops all of this turn's handlers at once.
 */
export type CodexThreadSubscription = {
  onNotification(method: string, handler: NotificationHandler): Disposable;
  onRequest(method: string, handler: RequestHandler): Disposable;
  expectTurnStart(): void;
  bindTurn(turnId: string | undefined): void;
  dispose(): void;
};

/** The threadId off a server payload, or '' when absent (drops to the orphan path). */
function readThreadId(params: unknown): string {
  if (typeof params !== 'object' || params === null) return '';
  return String((params as Record<string, unknown>).threadId ?? '');
}

/**
 * The turnId off a server payload, or null when absent. Most events carry it at
 * top-level `turnId`; the `turn/started` + `turn/completed` lifecycle events nest
 * it at `turn.id` instead (codex v2) — fall back to that so the terminal event is
 * filtered to its own turn, not fanned to every turn on the thread.
 */
function readTurnId(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  const value = p.turnId ?? (p.turn as { id?: unknown } | undefined)?.id;
  return value == null ? null : String(value);
}

function bindStartedTurn(subs: Set<SubState>, method: string, turnId: string | null): void {
  if (method !== 'turn/started' || turnId === null) return;
  const alreadyBound = [...subs].some((sub) => sub.turnId === turnId);
  const pending = [...subs].filter((sub) => sub.turnId === null && sub.awaitingTurnStart);
  if (alreadyBound || pending.length !== 1) return;
  pending[0].turnId = turnId;
  pending[0].awaitingTurnStart = false;
}

function canDeliverToTurn(sub: SubState, turnId: string | null): boolean {
  return sub.turnId === null || turnId === null || sub.turnId === turnId;
}

/** Reject `promise` if it doesn't settle within `ms` (the timer never holds the event loop). */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * A live connection to one `codex app-server`. Wraps the JSON-RPC connection
 * with the codex handshake (initialize + the `initialized` notification) and a
 * typed request/notification/approval surface.
 */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnection | null = null;
  private disposed = false;
  private disposalSettlement: Promise<void> | null = null;
  /** Live per-turn subscriptions, grouped by threadId for O(1) routing. */
  private readonly subsByThread = new Map<string, Set<SubState>>();
  /** Notification methods that already have their single connection router installed. */
  private readonly notifRouterMethods = new Set<string>();

  constructor(private readonly options: CodexAppServerClientOptions) {}

  /** Spawn `codex app-server`, perform the initialize handshake, return the result. */
  async start(): Promise<CodexInitializeResult> {
    const args = ['app-server', ...(this.options.args ?? [])];
    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    // Drain stderr so the pipe never blocks; log under debug only.
    child.stderr.on('data', (chunk: Buffer) => {
      if (process.env.DEBUG_CODEX_APP_SERVER) {
        log.info(`[Codex app-server stderr] ${chunk.toString('utf8')}`);
      }
    });
    child.on('error', (err) => log.error('[Codex app-server] spawn error', err));

    const reader = new NewlineMessageReader(child.stdout);
    const writer = new NewlineMessageWriter(child.stdin);
    // stdin EPIPE arrives async as a stream 'error', not a write() throw — route it to onError.
    // Never detached: a late EPIPE after dispose() would otherwise be an uncaughtException.
    child.stdin.on('error', (err) => {
      log.warn('[Codex app-server] stdin error', err);
      writer.reportStreamError(err);
    });
    const connection = createMessageConnection(reader, writer);
    for (const method of [...APPROVAL_REQUEST_METHODS, FRINK_HOST_TOOL_PERMISSION_METHOD]) {
      connection.onRequest(method, (params) => this.dispatchRequest(method, params));
    }
    connection.listen();
    this.connection = connection;

    const result = (await withTimeout(
      connection.sendRequest('initialize', {
        clientInfo: this.options.clientInfo,
        capabilities: { frinkHostToolPermission: FRINK_HOST_TOOL_PERMISSION_VERSION },
      }),
      INITIALIZE_TIMEOUT_MS,
      'codex app-server did not respond to initialize (wrong binary or hung process)',
    )) as CodexInitializeResult;
    if (result.capabilities?.frinkHostToolPermission !== FRINK_HOST_TOOL_PERMISSION_VERSION) {
      this.dispose();
      throw new Error(
        `Codex binary does not support Frink host permissions v${FRINK_HOST_TOOL_PERMISSION_VERSION}`,
      );
    }
    // Codex expects the `initialized` notification before any thread/turn calls.
    await connection.sendNotification('initialized');
    const extraRoots = this.options.extraSkillRoots ?? [];
    if (extraRoots.length > 0) {
      // The RPC REPLACES the process-global root set — safe because Frink
      // spawns this process and is its sole client. Awaited so the roots are
      // registered before the registry releases the client to thread/start;
      // failure is non-fatal (the session runs without vendor skills) but
      // recorded so the delivery probe reports it honestly.
      try {
        await connection.sendRequest('skills/extraRoots/set', { extraRoots });
        recordCodexSkillRootsRpcOutcome({ ok: true });
      } catch (err) {
        recordCodexSkillRootsRpcOutcome({ ok: false, error: String(err) });
        captureMainException(err, { surface: 'codex-vendor-skill-roots' });
      }
    }
    return result;
  }

  /** Send a client→server request and await the typed response. */
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connection) throw new Error('Codex app-server not started');
    return this.connection.sendRequest<T>(method, params);
  }

  /** Fire-and-forget client→server notification. */
  sendNotification(method: string, params?: unknown): Promise<void> {
    if (!this.connection) throw new Error('Codex app-server not started');
    return Promise.resolve(this.connection.sendNotification(method, params));
  }

  /**
   * Hand a turn its own threadId-scoped subscription. Stream notifications +
   * approval requests register here, NOT on the connection directly, so two
   * concurrent turns on this shared client cannot clobber each other.
   */
  forThread(threadId: string): CodexThreadSubscription {
    if (!this.connection) throw new Error('Codex app-server not started');
    const sub: SubState = {
      threadId,
      turnId: null,
      awaitingTurnStart: false,
      notif: new Map(),
      request: new Map(),
    };
    let set = this.subsByThread.get(threadId);
    if (!set) {
      set = new Set();
      this.subsByThread.set(threadId, set);
    }
    set.add(sub);
    return {
      onNotification: (method, handler) => {
        sub.notif.set(method, handler);
        this.ensureNotifRouter(method);
        return { dispose: () => sub.notif.delete(method) };
      },
      // Approval routers are installed eagerly in start(); just register the gate.
      onRequest: (method, handler) => {
        sub.request.set(method, handler);
        return { dispose: () => sub.request.delete(method) };
      },
      expectTurnStart: () => {
        sub.awaitingTurnStart = true;
      },
      bindTurn: (turnId) => {
        sub.turnId = turnId ?? null;
        sub.awaitingTurnStart = false;
      },
      dispose: () => {
        set.delete(sub);
        if (set.size === 0) this.subsByThread.delete(threadId); // don't leak empty thread keys
      },
    };
  }

  /** Install the single connection-level notification router for a method (idempotent). */
  private ensureNotifRouter(method: string): void {
    if (!this.connection || this.notifRouterMethods.has(method)) return;
    this.notifRouterMethods.add(method);
    this.connection.onNotification(method, (params) => this.dispatchNotification(method, params));
  }

  /** Fan a notification out to every subscription on its thread bound to its turn. */
  private dispatchNotification(method: string, params: unknown): void {
    const subs = this.subsByThread.get(readThreadId(params));
    if (!subs) return; // no live consumer for this thread → drop
    const turnId = readTurnId(params);
    bindStartedTurn(subs, method, turnId);
    for (const sub of subs) {
      const handler = sub.notif.get(method);
      // A bound turn ignores another turn's events on the same thread (two panes,
      // one conversation). Until bound (the silent pre-turn/start window) it takes all.
      if (handler && canDeliverToTurn(sub, turnId)) handler(params);
    }
  }

  /**
   * Route a server→client approval request to the one turn it belongs to (a request
   * gets exactly ONE response). Prefer the turnId-bound match; fall back to the sole
   * subscription on the thread; otherwise the request is orphaned (the turn ended, or
   * a registered approval with no live handler) → decline.
   */
  private dispatchRequest(method: string, params: unknown): unknown | Promise<unknown> {
    const turnId = readTurnId(params);
    const threadId = readThreadId(params);
    const matching = [...(this.subsByThread.get(threadId) ?? [])].filter((s) =>
      s.request.has(method),
    );
    const exactTurn = matching.find((s) => s.turnId !== null && s.turnId === turnId);
    const target =
      method === FRINK_HOST_TOOL_PERMISSION_METHOD
        ? exactTurn
        : (exactTurn ?? (matching.length === 1 ? matching[0] : undefined));
    const handler = target?.request.get(method);
    // Registered approvals without a live turn fail closed.
    if (!handler) {
      log.warn(
        `[Codex app-server] ${method} for orphaned thread=${threadId || '(none)'} turn=${turnId ?? '(none)'}; declining`,
      );
      return method === FRINK_HOST_TOOL_PERMISSION_METHOD
        ? { decision: 'deny', reason: 'No matching active Frink turn' }
        : declineApprovalResponse();
    }
    return handler(params);
  }

  /**
   * Fires when the connection closes — i.e. the `codex app-server` process exited
   * or its stdout ended. Lets the runner end a stuck turn and the registry evict
   * a dead client (a crash sends no turn/completed, so this is the only signal).
   */
  onClose(handler: () => void): Disposable {
    if (!this.connection) throw new Error('Codex app-server not started');
    return this.connection.onClose(handler);
  }

  /** Fires on a transport-level connection error. */
  onError(handler: (error: [Error, Message | undefined, number | undefined]) => void): Disposable {
    if (!this.connection) throw new Error('Codex app-server not started');
    return this.connection.onError(handler);
  }

  /** Tear down now, but settle only when the app-server process has actually closed. */
  disposeAndWait(): Promise<void> {
    if (this.disposalSettlement) return this.disposalSettlement;
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null) {
      this.disposalSettlement = Promise.resolve();
    } else {
      const barrier = createChildProcessCloseBarrier(child);
      this.disposalSettlement = barrier.settlement;
      barrier.arm({
        forceKill: () => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The settlement timeout remains the final guard if force-kill fails.
          }
        },
        forceKillDelayMs: DISPOSAL_FORCE_KILL_DELAY_MS,
        timeoutMs: DISPOSAL_TIMEOUT_MS,
        timeoutMessage: 'Codex app-server did not close after cancellation',
      });
    }
    this.dispose();
    return this.disposalSettlement;
  }

  /** Tear down the connection and kill the child. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.connection?.dispose();
    } catch {
      // ignore
    }
    try {
      this.child?.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.connection = null;
    this.child = null;
    this.subsByThread.clear();
  }
}
