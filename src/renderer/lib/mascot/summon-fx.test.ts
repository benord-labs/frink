import { describe, expect, it, vi } from 'vitest';
import { createSummonFx, type FxContext, type FxSurface } from './summon-fx';

/** A 2D context that accepts every call, so the effect maths runs without a real canvas. */
function fakeSurface(): FxSurface {
  const gradient: CanvasGradient = { addColorStop: () => {} };
  const ctx: FxContext = {
    beginPath: () => {},
    clearRect: () => {},
    createRadialGradient: () => gradient,
    ellipse: () => {},
    fill: () => {},
    fillRect: () => {},
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    lineTo: () => {},
    lineWidth: 1,
    moveTo: () => {},
    restore: () => {},
    save: () => {},
    setTransform: () => {},
    stroke: () => {},
    strokeStyle: '',
  };
  return { canvas: { width: 0, height: 0 }, ctx };
}

describe('createSummonFx', () => {
  it('does nothing when the canvas has no 2D context', () => {
    const fx = createSummonFx({ canvas: { width: 0, height: 0 }, ctx: null });
    fx.rift({ x: 0, y: 0 }, 100, 500);
    expect(() => fx.frame(0, 0.016)).not.toThrow();
  });
});

describe('createSummonFx idle frames', () => {
  it('stops clearing the canvas once every effect has finished', () => {
    const surface = fakeSurface();
    const clears = vi.fn();
    if (surface.ctx) surface.ctx.clearRect = clears;
    const fx = createSummonFx(surface);
    fx.chalkDust({ x: 0, y: 0 });

    for (let t = 0; t < 3000; t += 16) fx.frame(t, 0.016);
    const afterDust = clears.mock.calls.length;
    for (let t = 3000; t < 4000; t += 16) fx.frame(t, 0.016);

    expect(afterDust).toBeGreaterThan(0);
    expect(clears.mock.calls.length).toBe(afterDust);
  });
});
