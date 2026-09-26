import { describe, expect, it } from 'vitest';
import {
  attributeTrace,
  devToolsPortFile,
  formatHistory,
  formatReport,
  frameLabel,
  loadWarning,
} from './perf-trace.mjs';

type Node = {
  id: number;
  parent?: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
};

/** One thread's profile: nodes, then samples spaced `deltaUs` apart from `start`. */
function profile(
  id: string,
  pid: number,
  tid: number,
  start: number,
  nodes: Node[],
  samples: number[],
  deltaUs: number,
) {
  return [
    { name: 'Profile', id, pid, tid, ph: 'P', ts: start, args: { data: { startTime: start } } },
    {
      name: 'ProfileChunk',
      id,
      pid,
      tid,
      ph: 'P',
      ts: start,
      args: { data: { cpuProfile: { nodes, samples }, timeDeltas: samples.map(() => deltaUs) } },
    },
  ];
}

const frame = (functionName: string, url: string, lineNumber: number) => ({
  functionName,
  url,
  lineNumber,
});

// Thread A is the renderer main thread; thread B (Electron main process) has the longer task,
// reuses the same profile id and the same node ids for different code.
const rendererNodes: Node[] = [
  { id: 1, callFrame: frame('(root)', '', -1) },
  { id: 2, parent: 1, callFrame: frame('onFocus', 'http://localhost/deps/query.js?v=1', 1160) },
  { id: 3, parent: 2, callFrame: frame('', 'http://localhost/deps/query.js?v=1', 1161) },
  {
    id: 4,
    parent: 1,
    callFrame: frame('scan', 'https://unpkg.com/react-scan/dist/auto.global.js', 9),
  },
];
const mainProcessNodes: Node[] = [
  { id: 1, callFrame: frame('(root)', '', -1) },
  { id: 2, parent: 1, callFrame: frame('getWorktreeDiff', 'index.js', 26455) },
  { id: 3, parent: 2, callFrame: frame('raw', 'index.js', 4507) },
];

const events = [
  { name: 'thread_name', ph: 'M', pid: 1, tid: 10, ts: 0, args: { name: 'CrRendererMain' } },
  { name: 'thread_name', ph: 'M', pid: 2, tid: 20, ts: 0, args: { name: 'CrBrowserMain' } },
  // 300ms task on the renderer thread, plus a nested duplicate RunTask at the same start.
  { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 1_000_000, dur: 300_000 },
  { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 1_000_100, dur: 299_000 },
  { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 2_000_000, dur: 80_000 },
  { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 3_000_000, dur: 10_000 },
  // Main process: a longer 500ms task with its own profile.
  { name: 'RunTask', ph: 'X', pid: 2, tid: 20, ts: 1_000_000, dur: 500_000 },
  ...profile('0x1', 1, 10, 1_000_000, rendererNodes, [3, 3, 3, 4, 2], 50_000),
  ...profile('0x1', 2, 20, 1_000_000, mainProcessNodes, [3, 3, 3, 3], 50_000),
];

describe('attributeTrace', () => {
  const report = attributeTrace(events);

  it('prefers the renderer main thread over a longer main-process task and de-duplicates nested RunTasks', () => {
    expect(report?.thread).toEqual({ pid: 1, tid: 10 });
    expect(report?.tasks).toEqual([
      { ms: 300, atMs: 0 },
      { ms: 80, atMs: 1000 },
    ]);
  });

  it("uses that thread's own profile only, despite colliding profile and node ids in another process", () => {
    expect(report?.longest.selfByFunction).toEqual([
      ['(anon)@query.js:1162', 150],
      ['scan@react-scan:10', 50],
      ['onFocus@query.js:1161', 50],
    ]);
    expect(report?.longest.selfByFile).toEqual([
      ['query.js', 200],
      ['react-scan', 50],
    ]);
    expect(report?.longest.entryStacks[0]).toEqual([
      '(root)@:0 > onFocus@query.js:1161 > (anon)@query.js:1162',
      150,
    ]);
  });

  it('falls back to any profiled thread when no renderer thread has a long task', () => {
    expect(attributeTrace(events, { minTaskMs: 400 })?.thread).toEqual({ pid: 2, tid: 20 });
    expect(attributeTrace(events, { minTaskMs: 600 })).toBeNull();
  });
});

describe('attributeTrace edge cases', () => {
  it('never lets a negative sample delta subtract self time', () => {
    // Deltas 50, -30, 50: the reordered second sample sits before the first.
    const nodes: Node[] = [
      { id: 1, callFrame: frame('(root)', '', -1) },
      { id: 2, parent: 1, callFrame: frame('work', 'app.js', 0) },
    ];
    const negative = [
      { name: 'thread_name', ph: 'M', pid: 1, tid: 10, ts: 0, args: { name: 'CrRendererMain' } },
      { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 1_000_000, dur: 200_000 },
      {
        name: 'Profile',
        id: '0x1',
        pid: 1,
        tid: 10,
        ph: 'P',
        ts: 1_000_000,
        args: { data: { startTime: 1_000_000 } },
      },
      {
        name: 'ProfileChunk',
        id: '0x1',
        pid: 1,
        tid: 10,
        ph: 'P',
        ts: 1_000_000,
        args: {
          data: {
            cpuProfile: { nodes, samples: [2, 2, 2] },
            timeDeltas: [50_000, -30_000, 50_000],
          },
        },
      },
    ];
    // Sample gaps: -30 → 0, 50, and the last sample runs to the task end (130). Never 180 - 30.
    const self = attributeTrace(negative)?.longest.selfByFunction;
    expect(self).toEqual([['work@app.js:1', 180]]);
    expect(self?.every(([, ms]) => ms >= 0)).toBe(true);
  });

  it('attributes a sample whose node arrives in a later chunk', () => {
    const chunked = [
      { name: 'thread_name', ph: 'M', pid: 1, tid: 10, ts: 0, args: { name: 'CrRendererMain' } },
      { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 1_000_000, dur: 200_000 },
      {
        name: 'Profile',
        id: '0x1',
        pid: 1,
        tid: 10,
        ph: 'P',
        ts: 1_000_000,
        args: { data: { startTime: 1_000_000 } },
      },
      {
        name: 'ProfileChunk',
        id: '0x1',
        pid: 1,
        tid: 10,
        ph: 'P',
        ts: 1_000_000,
        args: {
          data: {
            cpuProfile: { nodes: [{ id: 1, callFrame: frame('(root)', '', -1) }], samples: [2] },
            timeDeltas: [50_000],
          },
        },
      },
      {
        name: 'ProfileChunk',
        id: '0x1',
        pid: 1,
        tid: 10,
        ph: 'P',
        ts: 1_100_000,
        args: {
          data: {
            cpuProfile: {
              nodes: [{ id: 2, parent: 1, callFrame: frame('late', 'app.js', 4) }],
              samples: [2],
            },
            timeDeltas: [50_000],
          },
        },
      },
    ];
    expect(attributeTrace(chunked)?.longest.selfByFunction).toEqual([['late@app.js:5', 150]]);
  });

  it('flags a task the profiler barely sampled, the signature of a starved or blocked thread', () => {
    const sparse = [
      { name: 'thread_name', ph: 'M', pid: 1, tid: 10, ts: 0, args: { name: 'CrRendererMain' } },
      { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 1_000_000, dur: 900_000 },
      {
        name: 'Profile',
        id: '0x1',
        pid: 1,
        tid: 10,
        ph: 'P',
        ts: 0,
        args: { data: { startTime: 0 } },
      },
      // One sample before the task, one 20ms into it, then nothing until after it ends.
      {
        name: 'ProfileChunk',
        id: '0x1',
        pid: 1,
        tid: 10,
        ph: 'P',
        ts: 0,
        args: {
          data: {
            cpuProfile: {
              nodes: [
                { id: 1, callFrame: frame('(root)', '', -1) },
                { id: 2, parent: 1, callFrame: frame('tick', 'app.js', 0) },
              ],
              samples: [2, 2, 2],
            },
            timeDeltas: [900_000, 120_000, 1_000_000],
          },
        },
      },
    ];
    const report = attributeTrace(sparse);
    expect(report?.longest.sampledMs).toBe(880);
    expect(formatReport(report)).toContain('880ms of it sampled');
    const starved = { ...report, longest: { ...report!.longest, sampledMs: 22 } };
    expect(formatReport(starved)).toContain('starved of CPU');
  });

  it('prefers the renderer serving the page origin over a DevTools window with a longer task', () => {
    const devtoolsNodes: Node[] = [
      { id: 1, callFrame: frame('(root)', '', -1) },
      { id: 2, parent: 1, callFrame: frame('paint', 'devtools://devtools/bundled/panels.js', 3) },
    ];
    const twoRenderers = [
      { name: 'thread_name', ph: 'M', pid: 1, tid: 10, ts: 0, args: { name: 'CrRendererMain' } },
      { name: 'thread_name', ph: 'M', pid: 3, tid: 30, ts: 0, args: { name: 'CrRendererMain' } },
      { name: 'RunTask', ph: 'X', pid: 1, tid: 10, ts: 1_000_000, dur: 100_000 },
      { name: 'RunTask', ph: 'X', pid: 3, tid: 30, ts: 1_000_000, dur: 900_000 },
      ...profile('0x1', 1, 10, 1_000_000, rendererNodes, [3, 3], 50_000),
      ...profile('0x1', 3, 30, 1_000_000, devtoolsNodes, [2, 2], 50_000),
    ];
    expect(attributeTrace(twoRenderers, { origin: 'http://localhost' })?.thread).toEqual({
      pid: 1,
      tid: 10,
    });
    expect(attributeTrace(twoRenderers)?.thread).toEqual({ pid: 3, tid: 30 });
  });
});

describe('devToolsPortFile', () => {
  it('follows Electron userData per platform', () => {
    expect(devToolsPortFile({ platform: 'darwin', home: '/Users/b' })).toBe(
      '/Users/b/Library/Application Support/Frink Dev/DevToolsActivePort',
    );
    expect(devToolsPortFile({ platform: 'linux', home: '/home/b' })).toBe(
      '/home/b/.config/Frink Dev/DevToolsActivePort',
    );
    expect(
      devToolsPortFile({
        platform: 'win32',
        home: 'C:/Users/b',
        appData: 'C:/Users/b/AppData/Roaming',
      }),
    ).toBe('C:/Users/b/AppData/Roaming/Frink Dev/DevToolsActivePort');
  });
});

describe('frameLabel', () => {
  it('prints 1-based lines and folds react-scan frames under one file', () => {
    expect(frameLabel(rendererNodes[2])).toBe('(anon)@query.js:1162');
    expect(frameLabel(rendererNodes[3])).toBe('scan@react-scan:10');
  });
});

describe('loadWarning', () => {
  it('warns only when the load average exceeds the core count', () => {
    expect(loadWarning({ loadavg: 3.2, cores: 10 })).toBe('load average 3.2 on 10 cores');
    expect(loadWarning({ loadavg: 32.7, cores: 10 })).toMatch(
      /^WARNING: load average 32.7 on 10 cores/,
    );
  });
});

describe('formatReport', () => {
  it('explains an empty report and appends probe lines to a full one', () => {
    expect(formatReport(null)).toBe('No task over the threshold on a profiled thread.');
    const text = formatReport(attributeTrace(events), ['longtask 120ms at 500']);
    expect(text).toContain('Longest task 300ms, 250ms of it sampled');
    expect(text).not.toContain('starved');
    expect(text).toContain('    longtask 120ms at 500');
  });
});

describe('formatHistory', () => {
  const clock = (epochMs: number) => `T+${Math.round(epochMs)}`;

  it('interleaves markers and slow frames oldest first, with properties and the frame cause', () => {
    const text = formatHistory(
      {
        origin: 1000,
        marks: [
          { kind: 'mark', at: 50, name: 'chat:open', properties: [['chatId', 'c1']] },
          { kind: 'mark', at: 400, name: 'stream:streaming', properties: [['subChatId', 's1']] },
        ],
        frames: [
          {
            kind: 'frame',
            at: 120,
            ms: 481.4,
            scriptMs: 460.2,
            styleLayoutMs: 27.1,
            top: {
              invoker: 'TimerHandler:setTimeout',
              fn: '',
              src: 'http://localhost:5173/deps/chunk-KE3V.js?v=1',
            },
          },
          { kind: 'frame', at: 300, ms: 60, scriptMs: 0, styleLayoutMs: 1, top: null },
        ],
      },
      clock,
    );
    expect(text.split('\n')).toEqual([
      'T+1050  · chat:open chatId=c1',
      'T+1120  ▲ 481ms frame  script 460  style/layout 27  TimerHandler:setTimeout chunk-KE3V.js',
      'T+1300  ▲ 60ms frame  script 0  style/layout 1  (no script)',
      'T+1400  · stream:streaming subChatId=s1',
    ]);
  });

  it('says so when the window is empty', () => {
    expect(formatHistory({ origin: 0, marks: [], frames: [] }, clock)).toBe(
      'No slow frames or markers in that window.',
    );
  });
});

describe('formatHistory dropped frames', () => {
  it('warns when the browser dropped slow frames because its buffer filled', () => {
    const text = formatHistory({ origin: 0, marks: [], frames: [], dropped: 37 }, () => 'T');
    expect(text).toContain('37 slow frame(s) were not buffered');
    expect(text).toContain('Reload the app');
  });
});
