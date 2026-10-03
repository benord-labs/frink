// Repro: a task dispatch fired while no renderer listener is mounted.
// Usage: node repro-missed-dispatch.mjs <qa agents.db> <qa main.log>
// Drives the booted QA app over CDP :9223. Exit 0 = prompt delivered, 1 = stranded.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [dbPath, logPath] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('sqlite3', ['-readonly', dbPath, q], { encoding: 'utf8' }).trim();
const log = (...a) => console.log(new Date().toISOString(), ...a);

const target = (await (await fetch('http://127.0.0.1:9223/json')).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cdp = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
// Raw trpc-electron request (superjson transformer) — the prod bundle exposes no modules.
const rpc = (type, path, input) =>
  evaluate(`new Promise((res, rej) => {
    const id = 900000 + Math.floor(Math.random() * 99999);
    window.electronTRPC.onMessage((m) => {
      if (m.id !== id) return;
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result?.data?.json ?? m.result?.data ?? null);
    });
    window.electronTRPC.sendMessage({ method: 'request', operation: { id, type: ${JSON.stringify(type)}, path: ${JSON.stringify(path)}, input: { json: ${JSON.stringify(input ?? null)} }, context: {} } });
  })`);

const appUrl = target.url;
const projectId = sql("select id from projects order by created_at limit 1");
log('app', appUrl, 'project', projectId);

await rpc('mutation', 'tasks.pausePoller');
const prompt = `QA missed-dispatch repro ${Date.now()}: reply with the single word OK.`;
const task = await rpc('mutation', 'tasks.create', { projectId, description: prompt, source: 'manual', requiresFilesystem: false });
log('created task', task.id, '(poller paused)');

// Resume the poller, then leave the app page at once: the claim + dispatch land while no
// `task:chat-ready` listener exists (same state as a reload or an unmounted chat layout).
await rpc('mutation', 'tasks.resumePoller');
await cdp('Page.navigate', { url: 'data:text/html,<title>away</title>listener unmounted' });
const awayAt = Date.now();
log('navigated away');

let dispatchedAt = 0;
let subChatId = '';
for (let i = 0; i < 60 && !dispatchedAt; i++) {
  await sleep(1000);
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const j = lines.findIndex((l, k) => l.includes('dispatching task:chat-ready') && lines.slice(k, k + 3).join('').includes(task.id));
  if (j < 0) continue;
  dispatchedAt = new Date(lines[j].slice(1, 24).replace(' ', 'T')).getTime();
  subChatId = lines.slice(j, j + 5).join('').match(/subChatId: '([^']+)'/)?.[1] ?? '';
}
if (!dispatchedAt) { log('FAIL-RIG: task never dispatched'); process.exit(2); }
log('dispatched', new Date(dispatchedAt).toISOString(), dispatchedAt > awayAt - 2000 ? '(while away)' : '(BEFORE leaving — race lost, rerun)');
await sleep(3000);

await cdp('Page.navigate', { url: appUrl });
log('navigated back; waiting for delivery');
// Delivered = the prompt's send reached main (a QA profile has no Claude login, so the turn itself
// then fails fast on credentials — quota-free, and irrelevant to delivery).
const bound = `task-dispatched send bound to task mode { subChatId: '${subChatId}'`;
let delivered = false;
for (let i = 0; i < 45 && !delivered; i++) {
  await sleep(1000);
  delivered = readFileSync(logPath, 'utf8').includes(bound);
}
log('task status', sql(`select status from tasks where id='${task.id}'`));
log(delivered ? 'DELIVERED: prompt reached the chat after the listener remounted' : 'STRANDED: prompt never reached the chat (bug reproduced)');
ws.close();
process.exit(delivered ? 0 : 1);
