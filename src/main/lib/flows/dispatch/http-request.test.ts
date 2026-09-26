/**
 * sc-2706: a url routes the request, so an unresolved placeholder must stop the node — rendered empty,
 * DELETE on items/{{previous.id}} would hit the whole items/ collection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchHttpRequest } from './http-request';

afterEach(() => {
  vi.restoreAllMocks();
});

function ctxWith(url: string, previousOutputs: { id?: string }) {
  // SAFETY: the literal supplies every DispatchContext field dispatchHttpRequest reads; it never
  // touches the database, the graph or the run ids.
  return {
    flowRunId: 'fr',
    nodeRunId: 'nr',
    userId: 'u1',
    node: {
      id: 'http',
      blockType: 'http_request',
      label: 'Delete item',
      config: { url, method: 'DELETE' },
    },
    previousOutput: { status: 'completed', outputs: previousOutputs, artifacts: [], durationMs: 0 },
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: { nodes: [], edges: [] },
    signal: new AbortController().signal,
  } as never;
}

describe('http_request fails closed on an unresolved url placeholder', () => {
  it('refuses a partly-resolved url rather than requesting its parent path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await dispatchHttpRequest(ctxWith('https://api.test/items/{{previous.id}}', {}));

    expect(res.type).toBe('error');
    // SAFETY: asserted above that res.type === 'error', the variant carrying `message`.
    expect((res as { message: string }).message).toContain('{{previous.id}}');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a url that is only an unresolved placeholder', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await dispatchHttpRequest(ctxWith('{{previous.id}}', {}));

    expect(res.type).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('http_request url guard edge shapes', () => {
  it('refuses a resolved-but-blank id in the path, which would retarget the request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await dispatchHttpRequest(
      ctxWith('https://api.test/items/{{previous.id}}', { id: '' }),
    );

    expect(res.type).toBe('error');
    // SAFETY: asserted above that res.type === 'error', the variant carrying `message`.
    expect((res as { message: string }).message).toContain('{{previous.id}}');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a non-string url from unchecked graph JSON as missing rather than throwing', async () => {
    const persisted: string = JSON.parse('123');

    const res = await dispatchHttpRequest(ctxWith(persisted, {}));

    expect(res).toEqual({ type: 'error', message: 'http_request missing url' });
  });
});
