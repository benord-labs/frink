/**
 * Debug ingest server — local HTTP endpoint that receives structured debug logs
 * from instrumented code and appends them as NDJSON to .frink/debug/<sessionId>.ndjson.
 *
 * Emulates Cursor's debug logging transport: agent instruments code with
 * fetch('http://127.0.0.1:<port>/ingest/<sessionId>', { method: 'POST', body: JSON.stringify({...}) })
 * and this server catches those POSTs, writing each payload as one NDJSON line.
 */

import fs from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import log from 'electron-log';
import { ensureDebugLogDir, getDebugLogPath } from './log-manager';

type DebugIngestSession = {
  sessionId: string;
  projectPath: string;
  logFilePath: string;
};

let server: Server | null = null;
let serverPort: number | null = null;
let startingPromise: Promise<number> | null = null;
const activeSessions = new Map<string, DebugIngestSession>();

/** Maximum POST body size (256 KB — debug payloads should be tiny). */
const MAX_BODY_SIZE = 256 * 1024;

const INGEST_PATH_RE = /^\/ingest\/([a-zA-Z0-9_-]+)$/;

/**
 * Pinned loopback port for the debug ingest server. Stable across app restarts
 * so instrumentation (`fetch('http://127.0.0.1:<port>/ingest/...')`) the agent
 * wrote in a previous session keeps working without re-instrumentation.
 *
 * Picked from the IANA dynamic/private range (49152–65535) and unassigned in
 * common service registries. If something else already holds it (e.g. another
 * Frink instance — same machine, exclusive TCP bind), we fall back to an
 * OS-assigned port. Session isolation is keyed on `sessionId`, not port, so
 * cross-instance log mixing isn't possible regardless.
 *
 * Exported for tests; runtime callers don't need to know the number.
 */
export const DEFAULT_INGEST_PORT = 49237;

const requestHandler: RequestListener = (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Debug-Session-Id',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const urlPath = req.url?.split('?')[0] ?? '';
  const match = urlPath.match(INGEST_PATH_RE);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const sessionId = match[1];
  const session = activeSessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Unknown session: ${sessionId}`);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;

  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload Too Large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (res.writableEnded) return;

    try {
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.parse(body);

      if (!payload.timestamp) {
        payload.timestamp = Date.now();
      }

      const line = `${JSON.stringify(payload)}\n`;
      fs.appendFile(session.logFilePath, line, 'utf8', (writeErr) => {
        if (writeErr) log.warn('[DebugIngest] Failed to write log entry:', writeErr);
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end('{"ok":true}');
    } catch (err) {
      log.warn('[DebugIngest] Failed to process log entry:', err);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
    }
  });

  req.on('error', (err) => {
    log.warn('[DebugIngest] Request error:', err);
  });
};

/**
 * Try to bind a fresh server to `port` (use 0 for OS-assigned). Resolves with
 * the bound server + actual port, or rejects with the listen error (typically
 * `EADDRINUSE` when something else holds the pinned port).
 */
function tryBind(port: number): Promise<{ srv: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = createServer(requestHandler);
    const onError = (err: Error) => {
      srv.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.removeListener('error', onError);
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve({ srv, port: addr.port });
      } else {
        srv.close();
        reject(new Error('Failed to get server address'));
      }
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Start the debug ingest server on 127.0.0.1, pinned to `DEFAULT_INGEST_PORT`
 * so instrumentation written in a previous app session keeps working after
 * restart. Falls back to an OS-assigned port if the pinned one is taken.
 *
 * Idempotent — returns existing port if already running.
 * Concurrent calls await the same startup promise to prevent orphaned servers.
 */
export async function startIngestServer(): Promise<number> {
  if (server && serverPort !== null) return serverPort;
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    let bound: { srv: Server; port: number };
    let fellBack = false;
    try {
      bound = await tryBind(DEFAULT_INGEST_PORT);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
      log.warn(
        `[DebugIngest] Pinned port ${DEFAULT_INGEST_PORT} unavailable (${code}); falling back to OS-assigned port`,
      );
      bound = await tryBind(0);
      fellBack = true;
    }

    server = bound.srv;
    serverPort = bound.port;
    server.on('error', (err) => log.error('[DebugIngest] Server error:', err));
    log.info(
      `[DebugIngest] Server listening on 127.0.0.1:${serverPort}${fellBack ? ' (fallback)' : ''}`,
    );
    return bound.port;
  })().finally(() => {
    startingPromise = null;
  });

  return startingPromise;
}

/**
 * Register a debug session. Creates the log directory and returns the endpoint URL + log file path.
 */
export function registerDebugSession(
  sessionId: string,
  projectPath: string,
): { endpointUrl: string; logFilePath: string } {
  ensureDebugLogDir(projectPath);
  const logFilePath = getDebugLogPath(projectPath, sessionId);

  activeSessions.set(sessionId, { sessionId, projectPath, logFilePath });
  log.info(`[DebugIngest] Registered session ${sessionId} → ${logFilePath}`);

  const endpointUrl = `http://127.0.0.1:${serverPort}/ingest/${sessionId}`;
  return { endpointUrl, logFilePath };
}

/** Unregister a debug session (does not delete the log file). */
export function unregisterDebugSession(sessionId: string): void {
  activeSessions.delete(sessionId);
  log.info(`[DebugIngest] Unregistered session ${sessionId}`);
}

/** Get the current server port, or null if not running. */
export function getIngestServerPort(): number | null {
  return serverPort;
}

/** Stop the ingest server and clear all sessions. */
export async function stopIngestServer(): Promise<void> {
  const srv = server;
  if (!srv) return;

  return new Promise<void>((resolve) => {
    srv.close(() => {
      log.info('[DebugIngest] Server stopped');
      server = null;
      serverPort = null;
      startingPromise = null;
      activeSessions.clear();
      resolve();
    });
  });
}
