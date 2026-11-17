import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRendererKind, connectPage, PAGE_IDENTITY_PROBE, VITE_CLIENT_PROBE } from './cdp.mjs';

// A rig launched from an agent shell once rendered the host's dev server while looking normal.
describe('assertRendererKind', () => {
  // The checkout under test; the default is the checkout this driver lives in.
  const ownIndex = '/Users/op/frink/out-qa/renderer/index.html';
  const bundled = pathToFileURL(ownIndex).href;
  const devServer = 'http://localhost:5173/';

  it('accepts the prebuilt out-qa renderer for a rig driver', () => {
    expect(() => assertRendererKind(bundled, 'bundle', { bundleIndex: ownIndex })).not.toThrow();
  });

  it("defaults to this checkout's own out-qa build", () => {
    const thisCheckout = join(import.meta.dirname, '../../../out-qa/renderer/index.html');
    expect(() => assertRendererKind(pathToFileURL(thisCheckout).href, 'bundle')).not.toThrow();
  });

  it('refuses to drive a rig whose window loaded a dev server, naming the URL it found', () => {
    expect(() => assertRendererKind(devServer, 'bundle', { bundleIndex: ownIndex })).toThrow(
      /http:\/\/localhost:5173.*boot\.sh/,
    );
  });

  it("refuses any other local renderer: still file://, still not this checkout's build", () => {
    for (const url of [
      'file:///tmp/unrelated/renderer/index.html',
      'file:///Users/op/frink/out/renderer/index.html', // the packaged build, not build.sh's
      'file:///Users/op/other-worktree/out-qa/renderer/index.html', // another checkout's rig bundle
    ]) {
      expect(() => assertRendererKind(url, 'bundle', { bundleIndex: ownIndex })).toThrow(/out-qa/);
    }
  });

  it('accepts its own out-qa renderer however the URL is spelled — hash route, encoded spaces', () => {
    const spacedIndex = '/Users/op/Personal and learning/frink/out-qa/renderer/index.html';
    const url = `${pathToFileURL(spacedIndex).href}#/chat`;
    expect(url).toContain('%20');
    expect(() => assertRendererKind(url, 'bundle', { bundleIndex: spacedIndex })).not.toThrow();
  });

  it('accepts a dev server for a driver that imports Vite-served modules', () => {
    expect(() => assertRendererKind(devServer, 'vite', { viteClient: true })).not.toThrow();
  });

  it('refuses an http(s) page that Vite did not serve, since its /@id imports would not resolve', () => {
    for (const url of [devServer, 'https://example.com/']) {
      expect(() => assertRendererKind(url, 'vite', { viteClient: false })).toThrow(/@vite\/client/);
    }
  });

  it('refuses a Vite-only driver against the bundle, instead of a cryptic module-not-found', () => {
    expect(() => assertRendererKind(bundled, 'vite', { bundleIndex: ownIndex })).toThrow(
      /Vite-served modules/,
    );
  });

  // A target caught before its first navigation commits (about:blank, or a blank URL) or after a failed
  // load (chrome-error://) has loaded no renderer at all: blaming a leaked dev server would send the
  // operator chasing env vars, and `new URL('')` would surface as a bare "Invalid URL".
  it.each(['about:blank', '', 'chrome-error://chromewebdata/'])(
    'says a page at %j has not loaded a renderer, in either mode, rather than misdiagnosing it',
    (url) => {
      for (const kind of ['bundle', 'vite']) {
        expect(() => assertRendererKind(url, kind)).toThrow(/has not loaded a renderer/);
      }
    },
  );
});

// connectPage against a fake CDP endpoint: /json/list over fetch, then a WebSocket that answers evaluate.
describe('connectPage', () => {
  const ownBundle = pathToFileURL(
    join(import.meta.dirname, '../../../out-qa/renderer/index.html'),
  ).href;
  let sockets;
  const DROP = Symbol('drop');

  // live: what the attached page reports for PAGE_IDENTITY_PROBE; other: answer for any other expression.
  function fakeCdp(targets, live, other = () => value(null)) {
    sockets = [];
    vi.stubGlobal('fetch', async () => ({ json: async () => targets }));
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          this.closed = false;
          sockets.push(this);
          setTimeout(() => this.onopen());
        }
        send(raw) {
          const { id, params } = JSON.parse(raw);
          const reply = params.expression === PAGE_IDENTITY_PROBE ? live : other(params.expression);
          // DROP: the target goes away mid-call — the socket closes and this call is never answered.
          if (reply === DROP) setTimeout(() => this.onclose?.({ code: 1006 }));
          else setTimeout(() => this.onmessage({ data: JSON.stringify({ id, ...reply }) }));
        }
        close() {
          this.closed = true;
        }
      },
    );
  }
  const page = (url) => ({ type: 'page', url, webSocketDebuggerUrl: 'ws://cdp/page' });
  const value = (v) => ({ result: { result: { value: v } } });
  const identity = (href, viteClient = false) => value({ href, viteClient });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes the Vite client as part of the page identity it reads', () => {
    expect(PAGE_IDENTITY_PROBE).toContain(VITE_CLIENT_PROBE);
  });

  it("attaches to this checkout's bundle, skipping DevTools, and evaluates in the page", async () => {
    fakeCdp(
      [page('devtools://devtools/bundled/inspector.html'), page(ownBundle)],
      identity(ownBundle),
      () => value(42),
    );
    const session = await connectPage('9223');
    expect(session.url).toBe(ownBundle);
    await expect(session.evaluate('6 * 7')).resolves.toBe(42);
    expect(sockets[0].closed).toBe(false);
  });

  it('refuses a leaked dev server and closes its socket', async () => {
    fakeCdp([page('http://localhost:5173/')], identity('http://localhost:5173/', true));
    await expect(connectPage('9223')).rejects.toThrow(/dev server leaked/);
    expect(sockets[0].closed).toBe(true);
  });

  it('judges the page it attached to, not a stale /json/list entry that has since navigated', async () => {
    fakeCdp([page(ownBundle)], identity('http://localhost:5173/', true));
    await expect(connectPage('9223')).rejects.toThrow(/dev server leaked/);
  });

  it('accepts a Vite-served page for a Vite driver once the page proves Vite served it', async () => {
    fakeCdp([page('http://localhost:5173/')], identity('http://localhost:5173/', true));
    await expect(connectPage('9223', { renderer: 'vite' })).resolves.toMatchObject({
      url: 'http://localhost:5173/',
    });
  });

  it('refuses, and closes its socket to, an http page Vite did not serve', async () => {
    fakeCdp([page('https://example.com/')], identity('https://example.com/', false));
    await expect(connectPage('9223', { renderer: 'vite' })).rejects.toThrow(/@vite\/client/);
    expect(sockets[0].closed).toBe(true);
  });

  it('closes its socket when the identity probe itself fails', async () => {
    fakeCdp([page(ownBundle)], { error: { code: -32000, message: 'Target closed' } });
    await expect(connectPage('9223')).rejects.toThrow(/Target closed/);
    expect(sockets[0].closed).toBe(true);
  });

  it('rejects, rather than hangs, when the target closes before answering the identity probe', async () => {
    fakeCdp([page(ownBundle)], DROP);
    await expect(connectPage('9223')).rejects.toThrow(/socket closed/);
    expect(sockets[0].closed).toBe(true);
  });

  it('rejects a call in flight when the target closes, and every call made after it', async () => {
    fakeCdp([page(ownBundle)], identity(ownBundle), () => DROP);
    const session = await connectPage('9223');
    await expect(session.evaluate('pending')).rejects.toThrow(/socket closed/);
    await expect(session.evaluate('later')).rejects.toThrow(/socket closed/);
  });

  it('names every target it saw when none is a page', async () => {
    fakeCdp([page('devtools://devtools/x')], identity(''));
    await expect(connectPage('9223')).rejects.toThrow(
      /no page target on :9223: devtools:\/\/devtools\/x/,
    );
    expect(sockets).toHaveLength(0);
  });

  it('surfaces an in-page exception and a CDP protocol error as rejections', async () => {
    fakeCdp([page(ownBundle)], identity(ownBundle), (expression) =>
      expression === 'boom'
        ? { result: { exceptionDetails: { exception: { description: 'Error: boom' } } } }
        : { error: { code: -32000, message: 'gone' } },
    );
    const session = await connectPage('9223');
    await expect(session.evaluate('boom')).rejects.toThrow('Error: boom');
    await expect(session.evaluate('other')).rejects.toThrow(/gone/);
  });
});
