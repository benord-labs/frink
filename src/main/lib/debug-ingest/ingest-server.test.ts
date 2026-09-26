import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// We need real fs for the ingest server to work, but mock ensureDebugLogDir/getDebugLogPath
// to avoid creating real directories.
vi.mock('./log-manager', () => ({
  ensureDebugLogDir: vi.fn(),
  getDebugLogPath: vi.fn((projectPath: string, sessionId: string) =>
    path.join(projectPath, '.frink', 'debug', `${sessionId}.ndjson`),
  ),
}));

import {
  DEFAULT_INGEST_PORT,
  getIngestServerPort,
  registerDebugSession,
  startIngestServer,
  stopIngestServer,
  unregisterDebugSession,
} from './ingest-server';

function postToEndpoint(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        // The default global agent pools sockets per host:port. With the server now
        // pinned to a fixed port across tests (and stop/start cycles between tests),
        // a pooled socket from the previous test points at a kernel-killed server
        // and the next request fails with ECONNRESET. Disable pooling so each test
        // gets a fresh TCP connection. Production fetch() calls live in a separate
        // process that restarts with the app, so they don't hit this problem.
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Connection: 'close',
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('ingest-server', () => {
  let appendFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    appendFileSpy = vi.spyOn(fs, 'appendFile').mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback signature
      (_path: any, _data: any, _opts: any, cb?: any) => {
        if (cb) cb(null);
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopIngestServer();
  });

  // Helper: probe whether DEFAULT_INGEST_PORT is currently free in this test env.
  // Returns true if we could bind+release it ourselves; false if another process holds it.
  // Tests that assert pinning behaviour skip when this returns false — the assertion
  // would be a false negative caused by the environment, not by our code.
  async function isPinnedPortFree(): Promise<boolean> {
    const probe = http.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.once('listening', () => resolve());
        probe.listen(DEFAULT_INGEST_PORT, '127.0.0.1');
      });
    } catch {
      return false;
    }
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return true;
  }

  describe('startIngestServer', () => {
    it('starts and returns the bound port', async () => {
      const port = await startIngestServer();
      expect(port).toBeGreaterThan(0);
      expect(getIngestServerPort()).toBe(port);
    });

    it('binds to DEFAULT_INGEST_PORT when it is free (pinning)', async () => {
      // Pinning is the whole point of the recent change — without it, instrumentation
      // written in a previous app session points at a stale port after restart, and
      // the agent has to re-instrument (token waste). This asserts the contract.
      if (!(await isPinnedPortFree())) return; // env adversarially holds the port
      const port = await startIngestServer();
      expect(port).toBe(DEFAULT_INGEST_PORT);
    });

    it('rebinds to the same port across stop/start cycles (pinning is stable)', async () => {
      // The user-facing invariant: instrumentation that hit `:49237` last app session
      // still hits a live endpoint after restart. If listen(0) regressed back in,
      // portA and portB would almost always differ.
      const portA = await startIngestServer();
      await stopIngestServer();
      const portB = await startIngestServer();
      expect(portB).toBe(portA);
    });

    it('falls back to OS-assigned port when DEFAULT_INGEST_PORT is held by another process', async () => {
      // Hold the pinned port with a dummy server so startIngestServer hits EADDRINUSE
      // on its first bind attempt. Verifies the safety net (and that the fallback
      // server is functional end-to-end, not just bound).
      const blocker = http.createServer();
      let blockerBound = false;
      try {
        await new Promise<void>((resolve, reject) => {
          blocker.once('error', reject);
          blocker.once('listening', () => resolve());
          blocker.listen(DEFAULT_INGEST_PORT, '127.0.0.1');
        });
        blockerBound = true;
      } catch {
        // Some other process already holds 49237 — startIngestServer will fall back
        // anyway, but we can't make a clean assertion that the fallback was *caused*
        // by our blocker. Skip rather than mislead.
        return;
      }

      try {
        const port = await startIngestServer();
        expect(port).toBeGreaterThan(0);
        expect(port).not.toBe(DEFAULT_INGEST_PORT);

        // End-to-end: register a session and POST through the fallback port.
        const { endpointUrl } = registerDebugSession('fallback-e2e', '/tmp/project');
        expect(endpointUrl).toContain(`:${port}`);
        const res = await postToEndpoint(endpointUrl, { message: 'fallback works' });
        expect(res.status).toBe(200);
      } finally {
        if (blockerBound) {
          await new Promise<void>((resolve) => blocker.close(() => resolve()));
        }
      }
    });

    it('is idempotent — second call returns same port', async () => {
      const port1 = await startIngestServer();
      const port2 = await startIngestServer();
      expect(port1).toBe(port2);
    });

    it('handles concurrent calls without orphaning servers (race condition #3)', async () => {
      // Two concurrent startIngestServer calls should resolve to the same port.
      // If the race condition exists, they'd create two servers on different ports.
      const [port1, port2] = await Promise.all([startIngestServer(), startIngestServer()]);

      // Both should resolve to the same port (no orphaned server)
      expect(port1).toBe(port2);
      expect(getIngestServerPort()).toBe(port1);
    });
  });

  describe('session registration', () => {
    it('registers a session and returns endpoint + log path', async () => {
      await startIngestServer();
      const port = getIngestServerPort();

      const result = registerDebugSession('test-session-1', '/tmp/project');

      expect(result.endpointUrl).toBe(`http://127.0.0.1:${port}/ingest/test-session-1`);
      expect(result.logFilePath).toContain('test-session-1.ndjson');
    });

    it('unregisters a session so POSTs return 404', async () => {
      await startIngestServer();
      const { endpointUrl } = registerDebugSession('session-unreg', '/tmp/project');

      // POST should succeed before unregister
      const res1 = await postToEndpoint(endpointUrl, { message: 'before' });
      expect(res1.status).toBe(200);

      unregisterDebugSession('session-unreg');

      // POST should 404 after unregister
      const res2 = await postToEndpoint(endpointUrl, { message: 'after' });
      expect(res2.status).toBe(404);
    });
  });

  describe('POST /ingest/:sessionId', () => {
    it('appends NDJSON line to the log file', async () => {
      await startIngestServer();
      const { endpointUrl } = registerDebugSession('session-ndjson', '/tmp/project');

      const payload = {
        hypothesisId: 'H1',
        location: 'file.ts:42',
        message: 'checking value',
        data: { key: 'value' },
        timestamp: 1733456789000,
      };

      const res = await postToEndpoint(endpointUrl, payload);
      expect(res.status).toBe(200);

      // Verify appendFileSync was called with the correct NDJSON line
      expect(appendFileSpy).toHaveBeenCalledOnce();
      const [filePath, content] = appendFileSpy.mock.calls[0] as [string, string, string];
      expect(filePath).toContain('session-ndjson.ndjson');
      const parsed = JSON.parse(content.trim());
      expect(parsed.hypothesisId).toBe('H1');
      expect(parsed.location).toBe('file.ts:42');
    });

    it('enriches with server-side timestamp when missing', async () => {
      await startIngestServer();
      const { endpointUrl } = registerDebugSession('session-ts', '/tmp/project');

      const payload = { hypothesisId: 'H1', message: 'no timestamp' };
      await postToEndpoint(endpointUrl, payload);

      const [, content] = appendFileSpy.mock.calls[0] as [string, string, string];
      const parsed = JSON.parse(content.trim());
      expect(parsed.timestamp).toBeTypeOf('number');
      expect(parsed.timestamp).toBeGreaterThan(0);
    });

    it('returns 404 for unknown session', async () => {
      await startIngestServer();
      const port = getIngestServerPort();
      const res = await postToEndpoint(`http://127.0.0.1:${port}/ingest/unknown`, {
        message: 'test',
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 for invalid path', async () => {
      await startIngestServer();
      const port = getIngestServerPort();
      const res = await postToEndpoint(`http://127.0.0.1:${port}/wrong/path`, {
        message: 'test',
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid JSON', async () => {
      await startIngestServer();
      const { endpointUrl } = registerDebugSession('session-bad', '/tmp/project');

      const parsed = new URL(endpointUrl);
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (r) => {
            r.resume();
            r.on('end', () => resolve({ status: r.statusCode ?? 0 }));
          },
        );
        req.on('error', reject);
        req.write('not json at all');
        req.end();
      });

      expect(res.status).toBe(400);
    });
  });

  describe('stopIngestServer', () => {
    it('clears all sessions and resets port', async () => {
      await startIngestServer();
      registerDebugSession('session-stop', '/tmp/project');

      await stopIngestServer();

      expect(getIngestServerPort()).toBeNull();
    });

    it('is idempotent when already stopped', async () => {
      await stopIngestServer();
      await stopIngestServer(); // should not throw
    });
  });
});
