import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

const listening = z.object({ port: z.number() });

/**
 * True for a request from a local program addressing this server by its loopback host:port. A web
 * page's request carries `Origin`, and a DNS-rebound page names a foreign `Host`.
 */
export function isLocalMcpCaller(
  headers: IncomingHttpHeaders,
  address: AddressInfo | string | null,
): boolean {
  const bound = listening.safeParse(address);
  if (headers.origin !== undefined || !bound.success) return false;
  const { port } = bound.data;
  return headers.host === `127.0.0.1:${port}` || headers.host === `localhost:${port}`;
}
