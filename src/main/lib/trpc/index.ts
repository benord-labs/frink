import { initTRPC } from '@trpc/server';
import type { BrowserWindow } from 'electron';
import superjson from 'superjson';
import { transformResultDataToCamelCase } from './case-convert-middleware';

/**
 * Context passed to all tRPC procedures
 */
export type Context = {
  getWindow: () => BrowserWindow | null;
  /** webContents ID of the window that sent this request (from trpc-electron IPC event) */
  senderWebContentsId?: number;
};

/**
 * Initialize tRPC with context and superjson transformer
 */
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
    };
  },
});

/**
 * Export reusable router and procedure helpers
 */
export const router = t.router;

const caseConvertOutput = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) return result;
  return {
    ...result,
    data: transformResultDataToCamelCase(result.data),
  } as typeof result;
});

/**
 * All query/mutation responses pass through `caseConvertOutput` so the
 * renderer never sees snake_case keys from raw Neon SQL rows. Subscriptions
 * bypass this middleware (see case-convert-middleware.ts).
 */
export const publicProcedure = t.procedure.use(caseConvertOutput);

/** No camelCase output conversion: use when the renderer reads a response key verbatim, of any
 * delimiter (flows DTOs, plugins.list). See decision `flows-ipc-casing-contract`. */
export const publicProcedureRaw = t.procedure;
