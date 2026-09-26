// sc-2818: adopting a version without its graph resurfaced as a phantom "unsaved changes" draft.

import { describe, expect, it } from 'vitest';
import { resolveServerAdoption } from './resolve-server-adoption';

type FlowSnapshot = {
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  version_number: number | null;
  graph: { nodes: string[] };
};

const V5: FlowSnapshot = { version_number: 5, graph: { nodes: ['trigger', 'list_feature_flags'] } };
const V6: FlowSnapshot = { version_number: 6, graph: { nodes: ['trigger', 'list_surveys'] } };

/** Working copy matches the graph its baseline version describes; no run on the canvas. */
const IDLE = { hydrated: true, locallyModified: false, runOnCanvas: false };

describe('resolveServerAdoption', () => {
  it('returns the whole snapshot — graph included — when an agent saves a newer version', () => {
    const adopted = resolveServerAdoption({ data: V6, ...IDLE, baselineVersion: 5 });

    expect(adopted).toBe(V6);
    expect(adopted?.graph).toEqual(V6.graph);
  });

  it('declines while the working copy differs from its baseline, so local work survives', () => {
    const adopted = resolveServerAdoption({
      data: V6,
      ...IDLE,
      locallyModified: true,
      baselineVersion: 5,
    });

    expect(adopted).toBeNull();
  });

  it('declines a version older than the baseline (the pre-invalidate cached response)', () => {
    expect(resolveServerAdoption({ data: V5, ...IDLE, baselineVersion: 6 })).toBeNull();
  });

  it('declines when the server is level with the baseline, so repeat polls are no-ops', () => {
    expect(resolveServerAdoption({ data: V6, ...IDLE, baselineVersion: 6 })).toBeNull();
  });

  it('declines a flow that has never been saved (null version_number)', () => {
    const unsaved: FlowSnapshot = { version_number: null, graph: { nodes: [] } };

    expect(resolveServerAdoption({ data: unsaved, ...IDLE, baselineVersion: 0 })).toBeNull();
  });

  it('declines before the first hydration and when the query has not landed', () => {
    expect(
      resolveServerAdoption({ data: V6, ...IDLE, hydrated: false, baselineVersion: 5 }),
    ).toBeNull();
    expect(resolveServerAdoption({ data: undefined, ...IDLE, baselineVersion: 5 })).toBeNull();
  });

  it('defers while a run is painted on the canvas, then adopts once it clears', () => {
    const during = resolveServerAdoption({
      data: V6,
      ...IDLE,
      runOnCanvas: true,
      baselineVersion: 5,
    });
    const after = resolveServerAdoption({ data: V6, ...IDLE, baselineVersion: 5 });

    expect(during).toBeNull();
    expect(after).toBe(V6);
  });
});
