import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { getRequestListener } from '@hono/node-server';
import { TRPCError } from '@trpc/server';
import { Hono, type HonoRequest } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  MOBILE_API_VERSION,
  MOBILE_PORT,
  mobileRequestSchema,
  type MobileRequest,
} from '../../../shared/types/remote/mobile';
import type { MobilePairingStore } from './pairing-store';
import { MobileApiError } from './domain/errors';

export type MobileExecutor = (request: MobileRequest) => Promise<unknown>;
type MobileEnvironment = { Variables: { mobileToken: string } };
const redemptionSchema = z.object({
  code: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
});
const domainErrorStatus = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 409,
  TOO_MANY_REQUESTS: 429,
} as const;

async function readJson(request: HonoRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new MobileApiError(400, 'Invalid JSON request body.');
    }
    throw error;
  }
}

export function createMobileApp(store: MobilePairingStore, execute: MobileExecutor) {
  const app = new Hono<MobileEnvironment>();
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    }),
  );
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    // Native requests do not send Origin. Reject browser contexts, even on the loopback hop.
    if (context.req.header('Origin'))
      return context.json({ error: 'Use the Frink mobile app.' }, 403);
    if (context.req.method !== 'POST') return context.json({ error: 'Method not allowed.' }, 405);
    const mediaType = context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return context.json({ error: 'Send an application/json request.' }, 415);
    }
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (context) => context.json({ error: 'Request is too large.' }, 413),
    }),
  );
  app.post('/pair', async (context) => {
    const input = redemptionSchema.parse(await readJson(context.req));
    const credentials = await store.redeem(input.code, input.name);
    return context.json({
      ...credentials,
      machineName: hostname(),
      apiVersion: MOBILE_API_VERSION,
    });
  });
  app.use(
    '/api',
    bearerAuth<MobileEnvironment>({
      verifyToken: (token, context) => {
        if (!store.authenticate(token)) return false;
        context.set('mobileToken', token);
        return true;
      },
      noAuthenticationHeader: { message: { error: 'Pair this device with Frink first.' } },
      invalidAuthenticationHeader: { message: { error: 'Invalid authorization header.' } },
      invalidToken: {
        message: { error: 'Access expired or was revoked. Pair this device again.' },
      },
    }),
  );
  app.post('/api', async (context) => {
    const request = mobileRequestSchema.parse(await readJson(context.req));
    if (!store.authenticate(context.get('mobileToken'))) {
      throw new MobileApiError(401, 'Access was revoked. Pair this device again.');
    }
    return context.json({ data: await execute(request) });
  });
  app.notFound((context) => context.json({ error: 'Not found.' }, 404));
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      const response = error.getResponse();
      return context.newResponse(response.body, response);
    }
    if (error instanceof MobileApiError)
      return context.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) {
      return context.json({ error: 'Invalid request. Check the values and try again.' }, 400);
    }
    if (error instanceof TRPCError && error.code in domainErrorStatus) {
      const status = domainErrorStatus[error.code as keyof typeof domainErrorStatus];
      return context.json({ error: error.message }, status);
    }
    return context.json(
      { error: 'Frink could not complete this request. Try again from the desktop.' },
      500,
    );
  });
  return app;
}

export async function startMobileServer(
  store: MobilePairingStore,
  execute: MobileExecutor,
  port = MOBILE_PORT,
): Promise<Server> {
  const app = createMobileApp(store, execute);
  const server = createServer(getRequestListener(app.fetch));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

export async function stopMobileServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
