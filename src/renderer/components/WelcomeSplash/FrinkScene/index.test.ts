// @vitest-environment jsdom
// jsdom (not node/happy-dom) because three's SVGLoader.parse uses DOMParser + element.style to
// read the mark SVG; happy-dom's style shim is too thin and trips SVGLoader's style parser.
import * as Three from 'three';
import { describe, expect, it } from 'vitest';
import { buildPieces, clamp01, computeMarkFrame, easeOutQuint } from './index';

describe('easeOutQuint', () => {
  it('maps the unit-interval endpoints exactly (0 -> 0, 1 -> 1)', () => {
    expect(easeOutQuint(0)).toBe(0);
    expect(easeOutQuint(1)).toBe(1);
  });

  it('is strictly increasing across [0,1] and front-loaded (an ease-OUT is past halfway by t=0.5)', () => {
    const ys = [0, 0.25, 0.5, 0.75, 1].map(easeOutQuint);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    expect(easeOutQuint(0.5)).toBeGreaterThan(0.5);
  });
});

describe('clamp01 (boundary values)', () => {
  it.each([
    [0, 0],
    [1, 1],
    [0.5, 0.5],
    [-1, 0],
    [-0.0001, 0],
    [2, 1],
    [Number.MAX_SAFE_INTEGER, 1],
  ])('clamp01(%p) === %p', (input, expected) => {
    expect(clamp01(input)).toBe(expected);
  });
});

describe('buildPieces', () => {
  it('parses the Frink mark into exactly 2 extruded pieces, each with non-empty fill + edge geometry', () => {
    const pieces = buildPieces();
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect(piece.fill).toBeInstanceOf(Three.ExtrudeGeometry);
      expect(piece.edges).toBeInstanceOf(Three.EdgesGeometry);
      // wrong-return guard: a piece with no vertices renders as nothing.
      expect(piece.fill.attributes.position.count).toBeGreaterThan(0);
      expect(piece.edges.attributes.position.count).toBeGreaterThan(0);
    }
  });
});

describe('computeMarkFrame (entrance timeline)', () => {
  it('holds the front-on outline pose while inactive, ignoring elapsed (edges lit, body hidden)', () => {
    expect(computeMarkFrame(0, false)).toEqual({
      rotation: [0, 0, 0],
      bodyOpacity: 0,
      edgeOpacity: 1,
    });
    // elapsed is ignored when inactive — the mark must not creep before the swap begins.
    expect(computeMarkFrame(99, false)).toEqual({
      rotation: [0, 0, 0],
      bodyOpacity: 0,
      edgeOpacity: 1,
    });
  });

  it('starts the entrance front-on with the body still hidden (edges = the drawn outline)', () => {
    const f = computeMarkFrame(0, true);
    expect(f.bodyOpacity).toBe(0);
    expect(f.edgeOpacity).toBe(1);
    // tilt has not begun (settle = 0); components are 0 (allowing JS -0 from the *settle product).
    for (const component of f.rotation) expect(component).toBeCloseTo(0, 10);
  });

  it('fills the body edges-first and only then begins the tilt (fill completes before settle)', () => {
    // ~end of the fill window: body solid, edge at its faint rest, but still front-on.
    const filled = computeMarkFrame(1.6, true);
    expect(filled.bodyOpacity).toBeCloseTo(1, 5);
    expect(filled.edgeOpacity).toBeCloseTo(0.25, 5);
    expect(filled.rotation[0]).toBeCloseTo(0, 1); // tilt only just starting
  });

  it('settles into a tilted, solid, idling pose well past the entrance window', () => {
    const settled = computeMarkFrame(5, true);
    expect(settled.bodyOpacity).toBeCloseTo(1, 5);
    expect(settled.edgeOpacity).toBeCloseTo(0.25, 5);
    expect(Math.abs(settled.rotation[0])).toBeGreaterThan(0.05); // nodded into the resting tilt
  });

  it('ramps body opacity monotonically from 0 to 1 across the fill window', () => {
    const a = computeMarkFrame(0.45, true).bodyOpacity; // start of fill
    const b = computeMarkFrame(1.0, true).bodyOpacity; // mid
    const c = computeMarkFrame(1.6, true).bodyOpacity; // end
    expect(a).toBeCloseTo(0, 5);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeCloseTo(1, 5);
  });
});
