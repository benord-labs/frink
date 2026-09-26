/**
 * Handlers buffer the raw bytes for HMAC verification before the signature check, so the read is
 * capped: uncapped, a guessable-URL endpoint is an unauthenticated memory-exhaustion DoS.
 */

import { WEBHOOK_BODY_MAX_BYTES } from './content-limits';

export class BodyTooLargeError extends Error {}

type RawBodyRequest = { rawBody?: Buffer | string };

export async function readRawBodyCapped(req: RawBodyRequest): Promise<string> {
  if (typeof req.rawBody === 'string') {
    if (Buffer.byteLength(req.rawBody) > WEBHOOK_BODY_MAX_BYTES) throw new BodyTooLargeError();
    return req.rawBody;
  }
  if (Buffer.isBuffer(req.rawBody)) {
    if (req.rawBody.length > WEBHOOK_BODY_MAX_BYTES) throw new BodyTooLargeError();
    return req.rawBody.toString('utf8');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer | string | Uint8Array>) {
    const buf =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
    total += buf.length;
    if (total > WEBHOOK_BODY_MAX_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
