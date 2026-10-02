#!/usr/bin/env node
/**
 * Record a DevTools-protocol trace of the running dev app and attribute its long main-thread
 * tasks to functions. react-scan only sees React render time; this sees everything the
 * renderer thread did, sampled by the V8 CPU profiler.
 *
 *   bun scripts/perf/perf-trace.mjs [--seconds 25] [--out <tmpdir>/frink-perf-trace.json] [--probe] [--invalidations]
 *     [--port 9222]
 *   bun scripts/perf/perf-trace.mjs --history [seconds]
 *
 * --history skips recording: it prints the slow frames the browser already buffered (every
 * animation frame over 50ms since page load) interleaved with the app's own `perfMark` markers
 * (chat opens, message loads, pane resizes, stream state, query updates), so a drop that
 * happened minutes ago can be read against what the app was doing.
 *
 * --probe also installs an in-page longtask observer plus focus/visibilitychange timing and
 * prints those lines with the report.
 *
 * --invalidations also records Blink's style-invalidation tracking and reports every style recalc
 * over 20ms with what changed just before it and which CSS rules widened it to whole subtrees
 * (e.g. a non-subject `:has()` restyling the entire document on each DOM insert).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatRestyles, rendererMainThreads, summarizeRestyles } from './restyles.mjs';

const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'toplevel',
].join(',');

const INVALIDATION_CATEGORY = 'disabled-by-default-devtools.timeline.invalidationTracking';

const PROBE_SCRIPT = `(() => {
  if (window.__perfTraceProbe) return;
  window.__perfTraceProbe = true;
  let t0 = 0;
  const mark = (line) => console.log('[probe]', line, performance.now().toFixed(1));
  window.addEventListener('focus', () => { t0 = performance.now(); mark('focus start'); }, true);
  window.addEventListener('focus', () => mark('focus handlers took ' + (performance.now() - t0).toFixed(1) + 'ms'));
  document.addEventListener('visibilitychange', () => { t0 = performance.now(); mark('visibility ' + document.visibilityState); }, true);
  document.addEventListener('visibilitychange', () => mark('visibility handlers took ' + (performance.now() - t0).toFixed(1) + 'ms'));
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) console.log('[probe]', 'longtask', e.duration.toFixed(0) + 'ms at', e.startTime.toFixed(0));
  }).observe({ entryTypes: ['longtask'] });
})()`;

/** Basename of the frame's script; react-scan frames fold into one file. */
export function frameFile(node) {
  const url = node.callFrame?.url ?? '';
  if (url.includes('react-scan') || url.includes('unpkg.com')) return 'react-scan';
  return url.split('/').pop().split('?')[0];
}

/** `name@file:line` with 1-based lines (matches editors). */
export function frameLabel(node) {
  const frame = node.callFrame ?? {};
  return `${frame.functionName || '(anon)'}@${frameFile(node)}:${(frame.lineNumber ?? -1) + 1}`;
}

/**
 * Group CPU-profile samples by the (pid, tid) that produced them; never merge across threads.
 * Profile ids restart per process, so the key carries the pid.
 */
function collectProfiles(events) {
  const key = (e) => `${e.pid}:${e.id}`;
  const profiles = new Map();
  for (const e of events) {
    if (e.name === 'Profile' && e.args?.data?.startTime !== undefined) {
      profiles.set(key(e), {
        pid: e.pid,
        tid: e.tid,
        start: e.args.data.startTime,
        nodes: new Map(),
        samples: [],
        deltas: [],
      });
    }
  }
  for (const e of events) {
    if (e.name === 'ProfileChunk') appendChunk(profiles.get(key(e)), e.args.data);
  }
  for (const p of profiles.values()) {
    linkChildren(p.nodes);
    p.sampledFrom = p.start + (p.deltas[0] ?? 0) - medianDelta(p.deltas.slice(1));
  }
  return [...profiles.values()];
}

/** The profiler's sampling interval; the first delta is not one (it spans the profiler's start-up). */
function medianDelta(deltas) {
  const sorted = deltas.filter((d) => d > 0).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function appendChunk(profile, data) {
  if (!profile) return;
  const cpu = data.cpuProfile ?? {};
  for (const n of cpu.nodes ?? []) profile.nodes.set(n.id, n);
  if (!cpu.samples) return;
  profile.samples.push(...cpu.samples);
  profile.deltas.push(...data.timeDeltas);
}

/** Older chunks carry `children` instead of `parent`; stacks walk `parent`. */
function linkChildren(nodes) {
  for (const n of nodes.values()) {
    for (const c of n.children ?? []) {
      const child = nodes.get(c);
      if (child) child.parent = n.id;
    }
  }
}

/** Nodes from the sampled leaf up to the root. */
function stackOf(profile, nodeId) {
  const path = [];
  for (let cur = nodeId; cur !== undefined; cur = profile.nodes.get(cur)?.parent) {
    const node = profile.nodes.get(cur);
    if (!node) break;
    path.push(node);
  }
  return path;
}

/** A renderer whose scripts load from the page's origin is the page, not DevTools or a sibling window. */
function servesOrigin(profile, origin) {
  return [...profile.nodes.values()].some((n) => (n.callFrame?.url ?? '').startsWith(origin));
}

function sortedEntries(map, limit) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => [k, Math.round(v / 1000)]);
}

/** Blink's per-frame rendering steps; they run outside JS, so the CPU profile cannot see them. */
const RENDER_PHASES = {
  UpdateLayoutTree: 'style',
  Layout: 'layout',
  PrePaint: 'prepaint',
  Paint: 'paint',
  Layerize: 'layerize',
  Commit: 'commit',
};

/** Time the task spent in each rendering step, largest first. */
function renderPhases(events, task) {
  const end = task.ts + task.dur;
  const byPhase = {};
  for (const e of events) {
    const phase = RENDER_PHASES[e.name];
    if (!phase || e.ph !== 'X' || e.pid !== task.pid || e.tid !== task.tid) continue;
    if (e.ts >= task.ts && e.ts + e.dur <= end) byPhase[phase] = (byPhase[phase] ?? 0) + e.dur;
  }
  return sortedEntries(byPhase).filter(([, ms]) => ms > 0);
}

/**
 * Attribute the long tasks of the thread that owns the longest task, preferring renderer main
 * threads over the Electron main process. Returns null when no thread has both a long task
 * and a CPU profile.
 */
export function attributeTrace(events, { minTaskMs = 50, limit = 12, origin = '' } = {}) {
  const profiles = collectProfiles(events);
  const renderers = rendererMainThreads(events);
  const profileOf = (e) => profiles.find((p) => p.pid === e.pid && p.tid === e.tid);
  const long = events
    .filter((e) => e.ph === 'X' && e.name === 'RunTask' && e.dur >= minTaskMs * 1000)
    .filter((e) => profileOf(e))
    .sort((a, b) => b.dur - a.dur);
  // The profiler only starts sampling once the thread yields, so a task already running when the
  // recording began has (almost) no samples; reading that as "not running JS" would be wrong.
  const profiled = long.filter((e) => e.ts >= profileOf(e).sampledFrom);
  const unsampled = long.filter((e) => e.ts < profileOf(e).sampledFrom);
  const onRenderer = profiled.filter((e) => renderers.has(`${e.pid}:${e.tid}`));
  const onPage = origin ? onRenderer.filter((e) => servesOrigin(profileOf(e), origin)) : [];
  const runTasks = onPage.length > 0 ? onPage : onRenderer.length > 0 ? onRenderer : profiled;
  const longest = runTasks[0];
  if (!longest) return null;
  const profile = profileOf(longest);
  // Nested RunTask events share a start; keep the outermost of each pair.
  const tasks = runTasks
    .filter((t) => t.pid === longest.pid && t.tid === longest.tid)
    .filter((t, i, all) => !all.some((o, j) => j < i && Math.abs(o.ts - t.ts) < 1000))
    .sort((a, b) => a.ts - b.ts);
  const firstTs = tasks[0].ts;

  let t = profile.start;
  const times = profile.deltas.map((d) => (t += d));
  const selfByFunction = {};
  const selfByFile = {};
  const entryStacks = {};
  const end = longest.ts + longest.dur;
  let sampled = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    if (times[i] < longest.ts || times[i] > end) continue;
    const path = stackOf(profile, profile.samples[i]);
    if (path.length === 0) continue;
    // A sample lasts until the next one. V8 emits occasional negative deltas (reordered
    // samples); those must not subtract from any frame.
    const dt = Math.max(0, Math.min(end, times[i + 1] ?? end) - times[i]);
    sampled += dt;
    const leaf = frameLabel(path[0]);
    selfByFunction[leaf] = (selfByFunction[leaf] ?? 0) + dt;
    const file = frameFile(path[0]);
    selfByFile[file] = (selfByFile[file] ?? 0) + dt;
    const entry = path.slice(-4).reverse().map(frameLabel).join(' > ');
    entryStacks[entry] = (entryStacks[entry] ?? 0) + dt;
  }
  return {
    thread: { pid: longest.pid, tid: longest.tid },
    unsampledMs: unsampled
      .filter((t) => t.pid === longest.pid && t.tid === longest.tid && t.dur > longest.dur)
      .map((t) => Math.round(t.dur / 1000)),
    tasks: tasks.map((task) => ({
      ms: Math.round(task.dur / 1000),
      atMs: Math.round((task.ts - firstTs) / 1000),
    })),
    longest: {
      ms: Math.round(longest.dur / 1000),
      sampledMs: Math.round(sampled / 1000),
      renderPhases: renderPhases(events, longest),
      selfByFunction: sortedEntries(selfByFunction, limit),
      selfByFile: sortedEntries(selfByFile, limit),
      entryStacks: sortedEntries(entryStacks, 6),
    },
  };
}

/** A sampled profile on a starved CPU blames whatever frame was running; say so up front. */
export function loadWarning({ loadavg = os.loadavg()[0], cores = os.cpus().length } = {}) {
  const line = `load average ${loadavg.toFixed(1)} on ${cores} cores`;
  return loadavg > cores
    ? `WARNING: ${line}. The machine is oversubscribed; long tasks below may be CPU starvation, not slow code.`
    : line;
}

export function formatReport(report, probeLines = []) {
  if (!report) return 'No task over the threshold on a profiled thread.';
  const { longest } = report;
  const renderMs = longest.renderPhases.reduce((sum, [, ms]) => sum + ms, 0);
  const lines = [
    `Thread pid ${report.thread.pid} tid ${report.thread.tid}: ${report.tasks.length} long task(s): ${report.tasks.map((t) => `${t.ms}ms@+${t.atMs}ms`).join(', ')}`,
    ...(report.unsampledMs.length
      ? [
          `Not attributed: ${report.unsampledMs.map((ms) => `${ms}ms`).join(', ')} began before the profiler's first sample (already running when recording started).`,
        ]
      : []),
    // Style/layout forced by a JS call (a `focus()`, a `getBoundingClientRect()`) also samples as JS.
    `Longest task ${longest.ms}ms, ${longest.sampledMs}ms of it sampled` +
      (renderMs
        ? `; rendering: ${longest.renderPhases.map(([k, v]) => `${k} ${v}ms`).join(', ')}`
        : '') +
      (longest.sampledMs + renderMs < longest.ms / 2
        ? ' — the thread was mostly neither running JS nor rendering (blocked, or starved of CPU)'
        : ''),
    '  self time by function (ms):',
    ...longest.selfByFunction.map(([k, v]) => `    ${String(v).padStart(5)} ${k}`),
    '  self time by file (ms):',
    ...longest.selfByFile.map(([k, v]) => `    ${String(v).padStart(5)} ${k}`),
    '  entry stacks (ms):',
    ...longest.entryStacks.map(([k, v]) => `    ${String(v).padStart(5)} ${k}`),
  ];
  if (probeLines.length) lines.push('  probe:', ...probeLines.map((l) => `    ${l}`));
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    seconds: 25,
    // Outside the repo: a trace is hundreds of MB, and Frink diffs every untracked file.
    out: join(os.tmpdir(), 'frink-perf-trace.json'),
    probe: false,
    invalidations: false,
    port: null,
    history: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--history') args.history = Number(argv[i + 1]) > 0 ? Number(argv[++i]) : 300;
    else if (argv[i] === '--seconds') args.seconds = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = resolve(argv[++i]);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--probe') args.probe = true;
    else if (argv[i] === '--invalidations') args.invalidations = true;
  }
  return args;
}

/** Electron's userData dir per platform (`electron-vite dev` writes DevToolsActivePort there). */
export function devToolsPortFile({
  platform = process.platform,
  home = os.homedir(),
  appData = process.env.APPDATA,
} = {}) {
  const userData =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (appData ?? join(home, 'AppData', 'Roaming'))
        : join(home, '.config');
  return join(userData, 'Frink Dev', 'DevToolsActivePort');
}

function devToolsPort(explicit) {
  if (explicit) return explicit;
  const portFile = devToolsPortFile();
  if (!existsSync(portFile))
    throw new Error(`Dev app is not running: ${portFile} missing. Start it with \`bun run dev\`.`);
  return Number(readFileSync(portFile, 'utf8').split('\n')[0]);
}

async function pageTarget(port) {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    throw new Error(
      `Nothing answers on DevTools port ${port}. The dev app is not running, or its DevToolsActivePort file is stale from an earlier run.`,
    );
  }
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('No page target on the DevTools port.');
  return page;
}

const historyScript = (sinceMs) => `new Promise((resolve) => {
  const since = performance.now() - ${sinceMs};
  const marks = performance.getEntriesByType('mark').filter((e) => e.startTime >= since)
    .map((e) => ({ kind: 'mark', at: e.startTime, name: e.name, properties: e.detail?.devtools?.properties ?? [] }));
  const done = (frames, dropped = 0) => resolve({ origin: performance.timeOrigin, marks, frames, dropped });
  const po = new PerformanceObserver((list, observer, options) => {
    po.disconnect();
    done(list.getEntries().filter((e) => e.startTime >= since).map((e) => {
      const top = e.scripts.slice().sort((a, b) => b.duration - a.duration)[0];
      return { kind: 'frame', at: e.startTime, ms: e.duration, scriptMs: e.scripts.reduce((a, s) => a + s.duration, 0),
        styleLayoutMs: e.startTime + e.duration - e.styleAndLayoutStart,
        top: top ? { invoker: top.invoker, fn: top.sourceFunctionName, src: top.sourceURL } : null };
    }), options?.droppedEntriesCount ?? 0);
  });
  po.observe({ type: 'long-animation-frame', buffered: true });
  setTimeout(() => { po.disconnect(); done([]); }, 500);
})`;

const localClock = (epochMs) =>
  new Date(epochMs).toLocaleTimeString('en-GB') +
  '.' +
  String(Math.round(epochMs) % 1000).padStart(3, '0');

/** One line per slow frame or marker, oldest first; marks carry their properties inline. */
export function formatHistory({ origin, marks, frames, dropped = 0 }, clock = localClock) {
  const short = (url) => (url ?? '').split('/').pop().split('?')[0];
  const lines = [...marks, ...frames]
    .sort((a, b) => a.at - b.at)
    .map((e) => {
      const stamp = clock(origin + e.at);
      if (e.kind === 'mark') {
        const props = e.properties.map(([k, v]) => `${k}=${v}`).join(' ');
        return `${stamp}  · ${e.name}${props ? ' ' + props : ''}`;
      }
      const cause = e.top
        ? [short(e.top.invoker) || e.top.invoker, e.top.fn, short(e.top.src)]
            .filter(Boolean)
            .join(' ')
        : '(no script)';
      return `${stamp}  ▲ ${Math.round(e.ms)}ms frame  script ${Math.round(e.scriptMs)}  style/layout ${Math.round(e.styleLayoutMs)}  ${cause}`;
    });
  // The browser buffers only the first slow frames since page load (200 in Chrome); after that,
  // newer drops are silently absent, which is the opposite of what a reader would assume.
  if (dropped > 0)
    lines.push(
      `WARNING: ${dropped} slow frame(s) were not buffered — the browser's buffer filled up, so recent drops are missing. Reload the app and reproduce again.`,
    );
  return lines.length ? lines.join('\n') : 'No slow frames or markers in that window.';
}

async function readHistory({ port, history }) {
  const page = await pageTarget(devToolsPort(port));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  const result = await new Promise((r) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) r(msg.result);
    };
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: historyScript(history * 1000),
          awaitPromise: true,
          returnByValue: true,
        },
      }),
    );
  });
  ws.close();
  if (result.exceptionDetails)
    throw new Error(`History read failed: ${result.exceptionDetails.text}`);
  return result.result.value;
}

async function record({ seconds, out, probe, invalidations, port }) {
  const page = await pageTarget(devToolsPort(port));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  const probeLines = [];
  let tracing = false;
  let finished;
  const complete = new Promise((r) => {
    finished = r;
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value);
    else if (msg.method === 'Tracing.tracingComplete') finished();
    else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description).join(' ');
      // Runtime.enable replays the console history; only lines from this recording count.
      if (tracing && text.startsWith('[probe]')) probeLines.push(text.slice(8));
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const id = ++nextId;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });

  if (probe) {
    await send('Runtime.enable');
    const { result } = await send('Runtime.evaluate', { expression: PROBE_SCRIPT });
    if (result?.exceptionDetails) throw new Error(`Probe failed: ${result.exceptionDetails.text}`);
  }
  const categories = invalidations
    ? `${TRACE_CATEGORIES},${INVALIDATION_CATEGORY}`
    : TRACE_CATEGORIES;
  await send('Tracing.start', { categories, transferMode: 'ReportEvents' });
  tracing = true;
  console.log(`Recording ${seconds}s on ${page.url} — reproduce the slowdown now.`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await send('Tracing.end');
  await complete;
  ws.close();
  writeFileSync(out, JSON.stringify({ traceEvents: events }));
  console.log(`${events.length} events written to ${out}`);
  return { events, probeLines, origin: new URL(page.url).origin };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  console.log(loadWarning());
  const run = args.history
    ? readHistory(args).then((history) => console.log(formatHistory(history)))
    : record(args);
  run
    .then((recorded) => {
      if (!recorded) return;
      console.log(
        formatReport(
          attributeTrace(recorded.events, { origin: recorded.origin }),
          recorded.probeLines,
        ),
      );
      if (args.invalidations) console.log(formatRestyles(summarizeRestyles(recorded.events)));
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
