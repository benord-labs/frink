import { createTRPCProxyClient } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import superjson from 'superjson';
import { ipcLink } from 'trpc-electron/renderer';
import type { AppRouter } from '../../main/lib/trpc/routers';

/**
 * React hooks for tRPC
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Vanilla client for use outside React components (stores, utilities)
 */
export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
});

// Expose trpcClient on window for console debugging (dev only)
if (typeof window !== 'undefined') {
  (window as unknown as { trpc: typeof trpcClient }).trpc = trpcClient;
}
