// Minimal CDP client for the QA app's page target (FRINK_CDP_PORT, default 9223); Vite serves renderer modules at /features/… and /lib/…, deps at /@id/<pkg>.
export async function connectPage(port = process.env.FRINK_CDP_PORT ?? '9223') {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !/^devtools:/.test(t.url));
  if (!page) throw new Error(`no page target on :${port}: ${targets.map((t) => t.url).join(', ')}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 600_000 });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result.value;
  };
  return { url: page.url, call, evaluate, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stamp = (m) => console.log(`${new Date().toISOString()} ${m}`);
