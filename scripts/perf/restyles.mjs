/**
 * Why a style recalc touched N elements: summarises Blink's style-invalidation tracking records
 * (`disabled-by-default-devtools.timeline.invalidationTracking`) around each slow recalc. Used by
 * `perf-trace.mjs --invalidations`.
 */

/** The trace covers every Chromium process; the page's JS runs on the renderer main thread. */
export function rendererMainThreads(events) {
  return new Set(
    events
      .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      .map((e) => `${e.pid}:${e.tid}`),
  );
}

const shortNode = (name = '') => (name.length > 70 ? `${name.slice(0, 70)}…` : name);

/** How each scheduling record names what changed, most specific first. */
const CHANGE_FIELDS = [
  ['changedPseudo', (v) => `:${v}`],
  ['changedAttribute', (v) => `[${v}]`],
  ['changedClass', (v) => `.${v}`],
  ['changedId', (v) => `#${v}`],
  ['reason', (v) => v],
];

/** ` via fn@file` for the JS frame Blink captured with the record, if any. */
function callerOf(data) {
  const caller = data.stackTrace?.[0];
  if (!caller) return '';
  const file = (caller.url ?? '').split('/').pop().split('?')[0];
  return ` via ${caller.functionName || '(anon)'}@${file}`;
}

/**
 * What a scheduling record says changed, and the JS that changed it:
 * `:has on BODY via insertOrAppendPlacementNode@react-dom_client.js`, `Animation on SPAN …`.
 */
function changeOf(e) {
  if (e.name === 'StyleInvalidatorInvalidationTracking') return null;
  const d = e.args?.data ?? {};
  const [field, show] = CHANGE_FIELDS.find(([key]) => d[key]) ?? [];
  return field ? `${show(d[field])} on ${shortNode(d.nodeName)}${callerOf(d)}` : null;
}

/** The rule text behind a whole-subtree invalidation, or null for a targeted one. */
function subtreeRuleOf(e) {
  const d = e.args?.data ?? {};
  if (!d.invalidationList?.some((i) => i.allDescendantsMightBeInvalid)) return null;
  const selectors = (d.selectors ?? []).map((x) => x.selector).join(' | ');
  return `${shortNode(d.nodeName)} ← ${selectors || '(selectors not recorded)'}`;
}

function countOncePerRecalc(target, keys) {
  for (const key of new Set(keys)) target[key] = (target[key] ?? 0) + 1;
}

/** Renderer-main-thread events, per thread, in time order. */
function rendererThreads(events) {
  const renderers = rendererMainThreads(events);
  const byThread = new Map();
  for (const e of events) {
    const thread = `${e.pid}:${e.tid}`;
    if (!renderers.has(thread)) continue;
    if (!byThread.has(thread)) byThread.set(thread, []);
    byThread.get(thread).push(e);
  }
  return [...byThread.values()].map((threadEvents) => threadEvents.sort((a, b) => a.ts - b.ts));
}

/**
 * Each style recalc on a thread, with the invalidation records that led to it: those since the
 * previous recalc, plus those Blink emits while the recalc runs.
 */
function recalcWindows(threadEvents) {
  const windows = [];
  let pending = [];
  for (const e of threadEvents) {
    const open = windows.at(-1);
    if (e.name === 'UpdateLayoutTree' && e.ph === 'X') {
      windows.push({ recalc: e, records: pending });
      pending = [];
    } else if (!e.name.endsWith('InvalidationTracking')) continue;
    else if (open && e.ts <= open.recalc.ts + open.recalc.dur) open.records.push(e);
    else pending.push(e);
  }
  return windows;
}

const topCounts = (counts, limit) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

/**
 * Style recalcs of at least `minMs` on renderer main threads, with the invalidation records that
 * led to each (those since the thread's previous recalc). Needs the invalidation-tracking category.
 */
export function summarizeRestyles(events, { minMs = 20, limit = 8 } = {}) {
  const slow = rendererThreads(events)
    .flatMap(recalcWindows)
    .filter(({ recalc }) => recalc.dur >= minMs * 1000);
  const changes = {};
  const subtreeRules = {};
  for (const { records } of slow) {
    countOncePerRecalc(changes, records.map(changeOf).filter(Boolean));
    countOncePerRecalc(subtreeRules, records.map(subtreeRuleOf).filter(Boolean));
  }
  const ms = slow.map(({ recalc }) => recalc.dur / 1000);
  return {
    count: slow.length,
    totalMs: Math.round(ms.reduce((sum, x) => sum + x, 0)),
    maxMs: Math.round(Math.max(0, ...ms)),
    maxElements: Math.max(0, ...slow.map(({ recalc }) => recalc.args?.elementCount ?? 0)),
    changes: topCounts(changes, limit),
    subtreeRules: topCounts(subtreeRules, limit),
  };
}

export function formatRestyles(summary, minMs = 20) {
  if (summary.count === 0) return `No style recalc over ${minMs}ms.`;
  const rows = (entries) => entries.map(([k, n]) => `    ${String(n).padStart(5)} ${k}`);
  return [
    `Style recalcs over ${minMs}ms: ${summary.count} (${summary.totalMs}ms total, max ${summary.maxMs}ms, up to ${summary.maxElements} elements)`,
    '  changes just before them (recalcs affected):',
    ...rows(summary.changes),
    '  rules that invalidated whole subtrees (recalcs affected):',
    ...(summary.subtreeRules.length ? rows(summary.subtreeRules) : ['    none']),
  ].join('\n');
}
