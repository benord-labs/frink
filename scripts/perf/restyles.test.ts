import { describe, expect, it } from 'vitest';
import { formatRestyles, summarizeRestyles } from './restyles.mjs';

describe('summarizeRestyles', () => {
  const thread = { pid: 1, tid: 10 };
  const schedule = (ts: number, data: Record<string, unknown>) => ({
    name: 'ScheduleStyleInvalidationTracking',
    ph: 'I',
    ...thread,
    ts,
    args: { data },
  });
  const invalidator = (ts: number, nodeName: string, selector: string, subtree: boolean) => ({
    name: 'StyleInvalidatorInvalidationTracking',
    ph: 'I',
    ...thread,
    ts,
    args: {
      data: {
        nodeName,
        invalidationList: [{ allDescendantsMightBeInvalid: subtree }],
        selectors: [{ selector }],
      },
    },
  });
  const recalc = (ts: number, ms: number, elementCount: number) => ({
    name: 'UpdateLayoutTree',
    ph: 'X',
    ...thread,
    ts,
    dur: ms * 1000,
    args: { elementCount },
  });
  const insert = [
    { functionName: 'insertOrAppendPlacementNode', url: 'http://x/react-dom.js?v=1' },
  ];
  const restyles = [
    { name: 'thread_name', ph: 'M', ...thread, ts: 0, args: { name: 'CrRendererMain' } },
    schedule(100, { changedPseudo: 'has', nodeName: 'BODY', stackTrace: insert }),
    invalidator(150, 'BODY', '.a:is(:where(.group):has(:focus-visible) *)', true),
    recalc(200, 70, 9000),
    // A cheap recalc resets the window: its records never count against the next slow one.
    schedule(100_000, { changedClass: 'open', nodeName: 'DIV' }),
    recalc(110_000, 1, 3),
    schedule(200_000, { changedPseudo: 'has', nodeName: 'BODY', stackTrace: insert }),

    invalidator(200_060, 'DIV', '.targeted', false),
    recalc(210_000, 90, 9100),
    // Blink also reports invalidation while the recalc runs; it belongs to that recalc.
    invalidator(210_500, 'BODY', '.a:is(:where(.group):has(:focus-visible) *)', true),
  ];

  it('lists the slow recalcs with the changes and whole-subtree rules behind them', () => {
    const summary = summarizeRestyles(restyles);
    expect(summary).toMatchObject({ count: 2, totalMs: 160, maxMs: 90, maxElements: 9100 });
    expect(summary.changes).toEqual([
      [':has on BODY via insertOrAppendPlacementNode@react-dom.js', 2],
    ]);
    expect(summary.subtreeRules).toEqual([
      ['BODY ← .a:is(:where(.group):has(:focus-visible) *)', 2],
    ]);
    expect(formatRestyles(summary)).toContain(
      'Style recalcs over 20ms: 2 (160ms total, max 90ms, up to 9100 elements)',
    );
  });

  it('says so when no recalc is slow', () => {
    expect(formatRestyles(summarizeRestyles(restyles, { minMs: 100 }), 100)).toBe(
      'No style recalc over 100ms.',
    );
  });
});
