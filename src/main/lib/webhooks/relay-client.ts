/** Claim this machine's addresses from the relay named by FRINK_WEBHOOK_BASE_URL, and hand every
 * forwarded frame's exact bytes to the same receiver the loopback listener calls. */

import log from 'electron-log';
import { io as connect, type Socket } from 'socket.io-client';
import { z } from 'zod';
import { WEBHOOK_BODY_MAX_BYTES } from '../../../shared/webhooks/content-limits';
import { receiveWebhook, type WebhookReceiverDeps } from '../../../shared/webhooks/receiver';
import { ingressBaseUrl } from './base-url';
import { receiverRequest } from './request';
import { recordingResponder } from './responder';

const MAX_HEADERS = 64;
const MAX_HEADER_NAME = 128;
const MAX_HEADER_VALUE = 8192;

/** Node hands a repeated header name through as a list, and the relay forwards it as it found it. */
const headerValue = z.string().max(MAX_HEADER_VALUE);

/** What the relay claims arrived, and the only shape this client will look at. A frame that misses
 * any of it is dropped where it lands: nothing about it is worth a log line or a table lookup. */
const inboundFrame = z.object({
  t: z.string().regex(/^[0-9a-f]{64}$/),
  provider: z.string().min(1),
  headers: z
    .record(z.string().max(MAX_HEADER_NAME), z.union([headerValue, z.array(headerValue)]))
    .refine((headers) => Object.keys(headers).length <= MAX_HEADERS),
  bodyB64: z.base64(),
});

type InboundFrame = z.infer<typeof inboundFrame>;

/** A frame as the relay sent it, which is a claim and nothing more until `inboundFrame` reads it. */
type UnverifiedFrame = { t?: unknown; provider?: unknown; headers?: unknown; bodyB64?: unknown };

export type RelayClientIo = {
  subscribeKeys(): Promise<string[]>;
  deps: WebhookReceiverDeps;
};

/** `refresh` claims an address minted since the last connect. `reachable` measures one thing: a
 * connection this client once had is gone. A relay that never answered has proved nothing. */
export type RelayClient = {
  droppedFrames(): number;
  reachable(): boolean;
  refresh(): void;
  close(): void;
};

function decodedBody(bodyB64: string): Buffer | null {
  const body = Buffer.from(bodyB64, 'base64');
  return body.length <= WEBHOOK_BODY_MAX_BYTES ? body : null;
}

async function claimAddresses(socket: Socket, io: RelayClientIo): Promise<void> {
  const keys = await io.subscribeKeys();
  for (const key of keys) socket.emit('subscribe', { key });
  log.info('[WebhookRelay] claimed addresses', { count: keys.length });
}

async function deliver(io: RelayClientIo, frame: InboundFrame, body: Buffer): Promise<void> {
  const responder = recordingResponder();
  await receiveWebhook(
    { ...receiverRequest(frame.provider, frame.t, frame.headers, 'POST'), rawBody: body },
    responder,
    io.deps,
  );
  log.info('[WebhookRelay] delivery', {
    address: frame.t.slice(0, 8),
    provider: frame.provider,
    bytes: body.length,
    verdict: responder.verdict(),
  });
}

/**
 * Null when no relay is named. A deactivated endpoint keeps its room until the next reconnect,
 * and its deliveries are dropped at the endpoint lookup meanwhile.
 */
export function startRelayClient(io: RelayClientIo): RelayClient | null {
  const baseUrl = ingressBaseUrl();
  if (!baseUrl) return null;

  let dropped = 0;
  let connectedOnce = false;
  const socket = connect(baseUrl, { transports: ['websocket'] });
  const claim = () => {
    void claimAddresses(socket, io).catch((error) => {
      io.deps.captureException(error, { context: 'webhook.relay_client' });
    });
  };

  socket.on('connect', () => {
    connectedOnce = true;
    claim();
  });

  socket.on('inbound', (claim: UnverifiedFrame) => {
    const frame = inboundFrame.safeParse(claim);
    const body = frame.success ? decodedBody(frame.data.bodyB64) : null;
    if (!frame.success || !body) {
      dropped += 1;
      return;
    }
    void deliver(io, frame.data, body).catch((error) => {
      io.deps.captureException(error, { context: 'webhook.relay_client' });
    });
  });

  return {
    droppedFrames: () => dropped,
    reachable: () => !connectedOnce || socket.connected,
    refresh: claim,
    close: () => socket.close(),
  };
}
