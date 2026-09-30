import * as z from 'zod/mini';
import { sendToApns, type Env } from './apns';
import { retryAfter } from './limit';

const MAX_BODY_BYTES = 512;
// Besides a 410, these APNs reasons mean the activity token will never work again.
const GONE_REASONS = new Set(['BadDeviceToken', 'ExpiredToken']);

const count = z.int().check(z.minimum(0), z.maximum(999));
const pushSchema = z.strictObject({
  token: z.string().check(z.regex(/^[0-9a-f]{64,400}$/)),
  event: z.enum(['update', 'end']),
  running: count,
  needsYou: count,
  urgent: z.boolean(),
});

const empty = (status: number, headers?: HeadersInit) => new Response(null, { status, headers });

async function forward(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get('content-length'));
  if (!length || length > MAX_BODY_BYTES) return empty(400);
  const parsed = pushSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return empty(400);

  const wait = retryAfter(parsed.data.token, parsed.data.event);
  if (wait > 0) return Response.json({ retryAfter: wait }, { status: 429 });

  const apns = await sendToApns(env, parsed.data).catch((error: unknown) => {
    console.warn('APNs request failed:', String(error));
  });
  if (!apns) return empty(502);
  if (apns.ok) return Response.json({ ok: true });
  const { reason } = (await apns.json().catch(() => ({}))) as { reason?: string };
  if (apns.status === 410 || GONE_REASONS.has(reason ?? ''))
    return Response.json({ gone: true }, { status: 410 });
  if (apns.status === 429) return Response.json({ retryAfter: 60 }, { status: 429 });
  console.warn(`APNs rejected the push: ${apns.status} ${reason}`);
  return empty(502);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    if (new URL(request.url).pathname !== '/live-activity') return empty(404);
    if (request.method !== 'POST') return empty(405, { allow: 'POST' });
    return forward(request, env);
  },
} satisfies ExportedHandler<Env>;
