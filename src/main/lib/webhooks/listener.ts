import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import { z } from 'zod';
import { receiveWebhook, type WebhookReceiverDeps } from '../../../shared/webhooks/receiver';
import { LOOPBACK_INGRESS_PORT } from './base-url';
import { receiverRequest } from './request';
import { httpResponder } from './responder';

/** The address shape the hosted receiver serves, so a tunnel in front of this is a drop-in. The
 * token alphabet is that address grammar; its length is the `path_token` CHECK migration 0101 sets. */
const TRIGGER_PATH = /^\/api\/triggers\/([a-z0-9_]{1,64})\/([A-Za-z0-9_-]{64})$/;

/** An address nobody has minted and an address nobody owns answer alike: no existence oracle. */
const NOT_FOUND = { status: 'ignored', reason: 'webhook_not_found_or_inactive' };

/** A TCP server's own address; a pipe server's string address never matches. */
const boundAddress = z.object({ port: z.number().int().positive() });

type WebhookListener = { port: number; close(): Promise<void> };

type ReceiverRequest = Parameters<typeof receiveWebhook>[0];

function asReceiverRequest(
  req: IncomingMessage,
  provider: string,
  id: string,
): ReceiverRequest & AsyncIterable<Buffer> {
  return {
    ...receiverRequest(provider, id, req.headers, req.method),
    [Symbol.asyncIterator]: () => req[Symbol.asyncIterator](),
  };
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookReceiverDeps,
  route: RegExpExecArray,
): Promise<void> {
  try {
    await receiveWebhook(asReceiverRequest(req, route[1], route[2]), httpResponder(res), deps);
  } catch (error) {
    deps.captureException(error, { context: 'webhook.local_listener' });
    if (!res.headersSent) httpResponder(res).status(500).json({ error: 'Internal server error' });
  } finally {
    // An oversized body is refused mid-stream; the sender is not invited to finish it.
    if (!req.readableEnded) req.destroy();
  }
}

function handle(req: IncomingMessage, res: ServerResponse, deps: WebhookReceiverDeps): void {
  const route = TRIGGER_PATH.exec((req.url ?? '').split('?')[0]);
  if (!route) {
    httpResponder(res).status(404).json(NOT_FOUND);
    return;
  }
  void serve(req, res, deps, route);
}

function bind(srv: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      srv.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.removeListener('error', onError);
      const address = boundAddress.safeParse(srv.address());
      if (address.success) resolve(address.data.port);
      else reject(new Error('Webhook listener bound to no TCP port'));
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, '127.0.0.1');
  });
}

export async function startWebhookListener(
  deps: WebhookReceiverDeps,
  port: number = LOOPBACK_INGRESS_PORT,
): Promise<WebhookListener> {
  const handler: RequestListener = (req, res) => handle(req, res, deps);
  const srv = createServer(handler);
  // Something else already holds the pinned port ⇒ take whatever the OS offers.
  const bound = await bind(srv, port).catch(() => bind(srv, 0));
  srv.on('error', (error) => deps.captureException(error, { context: 'webhook.local_listener' }));
  return {
    port: bound,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}
