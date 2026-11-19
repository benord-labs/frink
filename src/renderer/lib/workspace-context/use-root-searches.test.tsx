// @vitest-environment happy-dom
import { act, cleanup, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { useRootSearches } from './use-root-searches';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const ROOTS = [{ path: '/w/web' }, { path: '/w/api' }];
const found = (root: string) => [
  { id: `file:local:${root}`, label: 'a.ts', path: 'a.ts', repository: 'local', type: 'file' },
];

/** Renders the hook over ROOTS; /w/api's search waits until `finishApi` is called. */
function renderSearches(enabled = true) {
  let finishApi = () => {};
  const api = new Promise<void>((resolve) => {
    finishApi = resolve;
  });
  const asked = vi.fn(async (op: Operation) => {
    const { projectPath } = op.input as { projectPath: string };
    if (projectPath === '/w/api') await api;
    return found(projectPath);
  });
  const seen: { current?: ReturnType<typeof useRootSearches> } = {};
  function Probe() {
    seen.current = useRootSearches(ROOTS, 'a', enabled);
    return null;
  }
  renderWithTrpc(<Probe />, asked);
  return { searches: () => seen.current!, finishApi: () => act(finishApi), asked };
}

afterEach(cleanup);

describe('useRootSearches', () => {
  it('is fetching and loading while one folder has no results yet', async () => {
    const { searches, finishApi } = renderSearches();

    await waitFor(() => expect(searches().results).toEqual([found('/w/web'), undefined]));
    expect(searches()).toMatchObject({ isFetching: true, isLoading: true });

    await finishApi();
    await waitFor(() => expect(searches().results).toEqual([found('/w/web'), found('/w/api')]));
    expect(searches()).toMatchObject({ isFetching: false, isLoading: false });
  });

  it('searches nothing, and is neither fetching nor loading, while turned off', () => {
    const { searches, asked } = renderSearches(false);

    expect(searches()).toEqual({
      results: [undefined, undefined],
      isFetching: false,
      isLoading: false,
    });
    expect(asked).not.toHaveBeenCalled();
  });
});
