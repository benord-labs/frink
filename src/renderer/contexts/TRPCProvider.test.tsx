// @vitest-environment happy-dom

/**
 * Regression tests for the unified tRPC client fix.
 *
 * Context: the renderer previously instantiated two independent tRPC clients —
 * `trpcClient` (vanilla proxy, used imperatively for socket.sendStop etc.) and
 * a second one created inside TRPCProvider via `trpc.createClient({links:
 * [ipcLink(...)]})`. Each `ipcLink()` spawns its own internal `K` instance that
 * subscribes to `window.electronTRPC.onMessage` and keeps its own request-id
 * counter starting at 1. Both listeners received every response on the IPC
 * channel and matched by id against independent maps — concurrent mutations
 * (e.g. sendStop → `{success:true}`) cross-pollinated query caches whose
 * pending ids collided (projects.list → expected array).
 *
 * The fix (TRPCProvider.tsx) passes the module-level `trpcClient` straight to
 * `trpc.Provider`, so React hooks and imperative callers share one ipcLink
 * instance, one listener, and one id counter.
 *
 * These tests pin that invariant.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ElectronTRPCMock = {
  sendMessage: ReturnType<typeof vi.fn>;
  onMessage: ReturnType<typeof vi.fn>;
};

function installElectronTRPCMock(): ElectronTRPCMock {
  const mock: ElectronTRPCMock = {
    sendMessage: vi.fn(),
    onMessage: vi.fn(),
  };
  (globalThis as unknown as { electronTRPC: ElectronTRPCMock }).electronTRPC = mock;
  return mock;
}

describe('TRPCProvider — unified client invariant', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as unknown as { electronTRPC?: unknown }).electronTRPC;
  });

  it('subscribes to electronTRPC.onMessage exactly once after module load + TRPCProvider mount', async () => {
    const etrpc = installElectronTRPCMock();

    // Triggers `createTRPCProxyClient` at module load → one `new K()` in trpc-electron
    // → one `electronTRPC.onMessage(...)` call.
    await import('../lib/trpc');

    // Rendering the provider must NOT create a second ipcLink. If it did (regression:
    // `trpc.createClient({links: [ipcLink(...)]})` inside TRPCProvider), trpc-electron
    // would spawn another `new K()` which calls `onMessage` a second time, and the
    // cross-pollination bug from today's session returns: two clients, two id counters
    // starting at 1, concurrent mutations poisoning query caches sharing the same id.
    const { TRPCProvider } = await import('./TRPCProvider');
    render(
      <TRPCProvider>
        <div data-testid="child">child</div>
      </TRPCProvider>,
    );

    expect(etrpc.onMessage).toHaveBeenCalledTimes(1);
  });
});

// sc-2721: the default structural sharing re-minted every Date-bearing payload on each identical
// refetch, which re-rendered every sidebar row through the handlers keyed on projects.list.
describe('TRPCProvider — query client sharing', () => {
  afterEach(() => {
    cleanup();
    delete (globalThis as unknown as { electronTRPC?: unknown }).electronTRPC;
  });

  it('keeps the cached reference when an identical Date-bearing payload lands again', async () => {
    installElectronTRPCMock();
    const { TRPCProvider, getQueryClient } = await import('./TRPCProvider');
    render(
      <TRPCProvider>
        <div />
      </TRPCProvider>,
    );
    const client = getQueryClient();
    const key = [['projects', 'list'], { type: 'query' }];
    const payload = () => [{ id: 'p1', name: 'repo', createdAt: new Date('2026-09-01') }];

    const first = client?.setQueryData(key, payload());
    const second = client?.setQueryData(key, payload());

    expect(second).toBe(first);
  });
});
