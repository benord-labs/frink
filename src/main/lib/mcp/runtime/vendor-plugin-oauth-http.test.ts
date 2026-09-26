import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { waitForCallback } from './vendor-plugin-oauth-http';

const opts = { timeoutMs: 5_000, callbackPath: '/callback', cancelledMessage: 'cancelled' };
const browser = { redirect: 'manual' as const, headers: { connection: 'close' } };

async function probeFree(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

describe('waitForCallback', () => {
  it('settles a cancel issued before the bind completes and releases the port', async () => {
    const listener = waitForCallback(0, 'st', opts);
    listener.cancel();
    await expect(listener.code).rejects.toThrow('cancelled');
    await probeFree(await listener.port);
  });

  it('302s a granted callback into the next hop before settling the code, so the account leg follows in the same tab', async () => {
    const listener = waitForCallback(0, 'st', { ...opts, nextHop: 'https://vendor.test/oauth/connect/linear?session=t' });
    const port = await listener.port;
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=c1&state=st`, browser);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://vendor.test/oauth/connect/linear?session=t');
    await expect(listener.code).resolves.toBe('c1');
    await probeFree(port);
  });

  it('ends on the connected page when there is no next hop', async () => {
    const listener = waitForCallback(0, 'st', opts);
    const port = await listener.port;
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=c1&state=st`, browser);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Connected. You can close this tab and go back to Frink.');
    await expect(listener.code).resolves.toBe('c1');
  });

  it('a denial with our state ends on the cancelled page, never the next hop, and rejects the code', async () => {
    const listener = waitForCallback(0, 'st', { ...opts, nextHop: 'https://vendor.test/next' });
    const port = await listener.port;
    const response = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=st`, browser);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Sign-in cancelled. You can close this tab and go back to Frink.');
    await expect(listener.code).rejects.toThrow('access_denied');
  });

  it('a callback with our state but neither code nor error reads as a denial', async () => {
    const listener = waitForCallback(0, 'st', opts);
    const port = await listener.port;
    await fetch(`http://127.0.0.1:${port}/callback?state=st`, browser);
    await expect(listener.code).rejects.toThrow('access_denied');
  });

  it("a foreign state gets the stale page and settles nothing — the live consent keeps waiting", async () => {
    const listener = waitForCallback(0, 'st', { ...opts, nextHop: 'https://vendor.test/next' });
    const port = await listener.port;
    const stale = await fetch(`http://127.0.0.1:${port}/callback?code=old&state=other`, browser);
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain('This sign-in link is out of date.');
    const live = await fetch(`http://127.0.0.1:${port}/callback?code=fresh&state=st`, browser);
    expect(live.status).toBe(302);
    await expect(listener.code).resolves.toBe('fresh');
  });

  it('serves nothing but the callback path: /start is gone', async () => {
    const listener = waitForCallback(0, 'st', opts);
    const port = await listener.port;
    expect((await fetch(`http://127.0.0.1:${port}/start`, browser)).status).toBe(404);
    listener.cancel();
    await expect(listener.code).rejects.toThrow('cancelled');
  });
});
