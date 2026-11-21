import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLocalMcpCaller } from './local-caller';

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(isLocalMcpCaller(req.headers, server.address()) ? 200 : 403).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function status(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

describe('isLocalMcpCaller', () => {
  it('accepts a local client that names the server by its loopback address', async () => {
    expect(await status({})).toBe(200);
    expect(await status({ Host: `localhost:${port}` })).toBe(200);
  });

  it('refuses any request carrying Origin, as every web page request does', async () => {
    expect(await status({ Origin: 'https://evil.example' })).toBe(403);
    expect(await status({ Origin: 'null' })).toBe(403);
  });

  it('refuses a DNS-rebound page that names a foreign host', async () => {
    expect(await status({ Host: `evil.example:${port}` })).toBe(403);
    expect(await status({ Host: '127.0.0.1:1' })).toBe(403);
  });

  it('refuses when the server has no TCP address', () => {
    expect(isLocalMcpCaller({ host: '127.0.0.1:80' }, null)).toBe(false);
    expect(isLocalMcpCaller({ host: '127.0.0.1:80' }, '/tmp/socket')).toBe(false);
  });
});
