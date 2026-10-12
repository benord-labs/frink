// Minimal CDP client for the QA app's page target (FRINK_CDP_PORT, default 9223). Under an electron-vite dev server (renderer: 'vite'), Vite serves renderer modules at /features/… and /lib/…, deps at /@id/<pkg>; the prebuilt rig bundle has none of those.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The bundle scripts/qa/build.sh writes for THIS checkout — the code a driver here means to measure.
const OWN_BUNDLE_INDEX = join(import.meta.dirname, '../../../out-qa/renderer/index.html');
const canonical = (path) => (existsSync(path) ? realpathSync(path) : path);

// Which renderer a driver is allowed to measure. 'bundle' (the rig default) is the prebuilt out-qa
// renderer loaded from file://; 'vite' is an electron-vite dev server, for drivers that import
// Vite-served modules. A rig launched from a Frink Dev agent shell once silently loaded the HOST's dev
// server, so every driver asserts what it is attached to before driving or measuring.
// Vite's dev server injects this script into every page it serves; no other server does.
export const VITE_CLIENT_PROBE = 'Boolean(document.querySelector(\'script[src="/@vite/client"]\'))';
// Read from the attached page itself: /json/list can be stale by the time the socket opens.
export const PAGE_IDENTITY_PROBE = `({ href: location.href, viteClient: ${VITE_CLIENT_PROBE} })`;

// viteClient: the VITE_CLIENT_PROBE result for the page (required to accept 'vite').
export function assertRendererKind(
  url,
  kind,
  { bundleIndex = OWN_BUNDLE_INDEX, viteClient = false } = {},
) {
  const protocol = URL.canParse(url) ? new URL(url).protocol : '';
  const served = protocol === 'http:' || protocol === 'https:';
  // Before its first navigation commits (about:blank, blank) or after a failed load (chrome-error://)
  // the page holds no renderer at all, so neither diagnosis below would be true.
  if (protocol !== 'file:' && !served) {
    throw new Error(
      `the page at ${JSON.stringify(url)} has not loaded a renderer — wait for the app to finish booting, or check its main log for a load failure`,
    );
  }
  if (kind === 'bundle' && protocol !== 'file:') {
    throw new Error(
      `expected the prebuilt out-qa renderer (file://) but the page is ${url} — a dev server leaked into the rig launch; boot it with scripts/qa/boot.sh`,
    );
  }
  // file:// alone is not enough: the packaged out/ build, or another checkout's rig, is local too.
  if (kind === 'bundle' && canonical(fileURLToPath(url)) !== canonical(bundleIndex)) {
    throw new Error(
      `expected this checkout's out-qa renderer (${bundleIndex}) but the page is ${url} — boot it from this checkout with scripts/qa/boot.sh`,
    );
  }
  if (kind === 'vite' && !(served && viteClient)) {
    throw new Error(
      `this driver imports Vite-served modules, but the page is ${url} — it has no /@vite/client script, so Vite did not serve it; run it against an electron-vite dev instance (FRINK_CDP_PORT + FRINK_HOME), not the QA bundle`,
    );
  }
}

async function findPageTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
  if (!page) throw new Error(`no page target on :${port}: ${targets.map((t) => t.url).join(', ')}`);
  return page;
}

async function openSession(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  // A target that goes away never answers: reject what is in flight, and everything sent after.
  let gone = null;
  const fail = (reason) => {
    gone ??= new Error(`CDP socket closed (${reason}) — the page target went away`);
    for (const p of pending.values()) p.reject(gone);
    pending.clear();
  };
  ws.onclose = ({ code }) => fail(`code ${code}`);
  ws.onerror = () => fail('error');
  const call = (method, params = {}) =>
    gone
      ? Promise.reject(gone)
      : new Promise((resolve, reject) => {
          pending.set(++id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
  return { call, close: () => ws.close() };
}

async function evaluateIn(call, expression) {
  const r = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 600_000,
  });
  const failure = r.exceptionDetails;
  if (failure) throw new Error((failure.exception?.description ?? failure.text).slice(0, 400));
  return r.result.value;
}

export async function connectPage(
  port = process.env.FRINK_CDP_PORT ?? '9223',
  { renderer = 'bundle' } = {},
) {
  const page = await findPageTarget(port);
  const { call, close } = await openSession(page.webSocketDebuggerUrl);
  const evaluate = (expression) => evaluateIn(call, expression);
  try {
    const live = await evaluate(PAGE_IDENTITY_PROBE);
    assertRendererKind(live.href, renderer, { viteClient: live.viteClient });
    return { url: live.href, call, evaluate, close };
  } catch (error) {
    close(); // a refused or failed probe must not strand the session
    throw error;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stamp = (m) => console.log(`${new Date().toISOString()} ${m}`);
