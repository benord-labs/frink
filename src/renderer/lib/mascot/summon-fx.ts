/** 2D effects for the HELPFRINK summon on one full-window canvas: the time rift,
 * chalk dust and hover jets. */

import { easeOut } from './timeline';

type Point = { x: number; y: number };

type Dust = {
  kind: 'dust';
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  drag: number;
  age: number;
  life: number;
  size: number;
  rgb: string;
};

type Rift = { at: Point; height: number; duration: number; start: number; burst: boolean };

const CHALK = '241,239,230';
const CYAN = '126,249,255';
const PINK = '255,120,230';

/** The slice of a 2D canvas context the effects draw with. */
export type FxContext = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'clearRect'
  | 'createRadialGradient'
  | 'ellipse'
  | 'fill'
  | 'fillRect'
  | 'fillStyle'
  | 'globalCompositeOperation'
  | 'lineTo'
  | 'lineWidth'
  | 'moveTo'
  | 'restore'
  | 'save'
  | 'setTransform'
  | 'stroke'
  | 'strokeStyle'
>;

/** Where the effects draw: the canvas to size, and its context (null when 2D is unavailable). */
export type FxSurface = { canvas: { width: number; height: number }; ctx: FxContext | null };

export type SummonFx = {
  resize: (width: number, height: number, pixelRatio: number) => void;
  rift: (at: Point, height: number, durationMs: number) => void;
  chalkDust: (at: Point) => void;
  hoverJet: (at: Point) => void;
  frame: (now: number, dtSeconds: number) => void;
  clear: () => void;
};

function dust(at: Point, init: Partial<Dust>): Dust {
  return {
    kind: 'dust',
    x: at.x,
    y: at.y,
    vx: 0,
    vy: 0,
    gravity: 0,
    drag: 1,
    age: 0,
    life: 600,
    size: 1.5,
    rgb: CHALK,
    ...init,
  };
}

export function createSummonFx({ canvas, ctx }: FxSurface): SummonFx {
  let width = 0;
  let height = 0;
  let particles: Dust[] = [];
  let rifts: Rift[] = [];
  let clean = true;

  function sparks(at: Point, count: number) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 260;
      particles.push(
        dust(at, {
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          drag: 0.93,
          life: 400 + Math.random() * 500,
          size: 1 + Math.random() * 1.6,
          rgb: Math.random() < 0.5 ? CYAN : PINK,
        }),
      );
    }
  }

  function drawRift(r: Rift, now: number): boolean {
    if (!ctx) return false;
    const p = Math.max(0, (now - r.start) / r.duration);
    if (p >= 1) return false;
    const open = p < 0.3 ? easeOut(p / 0.3) : p < 0.62 ? 1 : 1 - easeInOut((p - 0.62) / 0.38);
    if (p > 0.97 && !r.burst) {
      r.burst = true;
      sparks(r.at, 36);
    }
    const ry = (r.height / 2) * Math.min(1, open * 1.4);
    const rx = 3 + 26 * open * open;
    const { x, y } = r.at;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, ry));
    glow.addColorStop(0, `rgba(255,255,255,${0.95 * open})`);
    glow.addColorStop(0.25, `rgba(${CYAN},${0.7 * open})`);
    glow.addColorStop(0.6, `rgba(255,94,219,${0.35 * open})`);
    glow.addColorStop(1, 'rgba(255,94,219,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 2.2, Math.max(1, ry * 1.1), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${open})`;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(1, rx * 0.35), Math.max(1, ry * 0.92), 0, 0, Math.PI * 2);
    ctx.fill();
    return true;
  }

  function stepDust(d: Dust, dt: number): boolean {
    if (!ctx || d.age >= d.life) return false;
    d.vx *= d.drag;
    d.vy = d.vy * d.drag + d.gravity * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    ctx.fillStyle = `rgba(${d.rgb},${0.9 * (1 - d.age / d.life)})`;
    ctx.fillRect(d.x, d.y, d.size, d.size);
    return true;
  }

  return {
    resize(w, h, pixelRatio) {
      width = w;
      height = h;
      canvas.width = Math.round(w * pixelRatio);
      canvas.height = Math.round(h * pixelRatio);
      ctx?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    },
    rift(at, riftHeight, durationMs) {
      rifts.push({
        at,
        height: riftHeight,
        duration: durationMs,
        start: performance.now(),
        burst: false,
      });
    },
    chalkDust(at) {
      particles.push(
        dust(
          { x: at.x + (Math.random() - 0.5) * 4, y: at.y },
          {
            vx: (Math.random() - 0.5) * 30,
            vy: Math.random() * 20,
            gravity: 520,
            life: 700 + Math.random() * 600,
            size: 0.8 + Math.random() * 1.4,
          },
        ),
      );
    },
    hoverJet(at) {
      particles.push(
        dust(
          { x: at.x + (Math.random() - 0.5) * 14, y: at.y },
          {
            vx: (Math.random() - 0.5) * 20,
            vy: 40 + Math.random() * 40,
            gravity: 80,
            life: 380 + Math.random() * 260,
            size: 1.2 + Math.random(),
            rgb: CYAN,
          },
        ),
      );
    },
    frame(now, dt) {
      // Idle frames cost nothing: clear once after the last effect ends, then stop drawing.
      const idle = rifts.length === 0 && particles.length === 0;
      if (!ctx || (idle && clean)) return;
      clean = idle;
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      rifts = rifts.filter((r) => drawRift(r, now));
      particles = particles.filter((p) => {
        p.age += dt * 1000;
        return stepDust(p, dt);
      });
      ctx.restore();
    },
    clear() {
      particles = [];
      rifts = [];
      ctx?.clearRect(0, 0, width, height);
    },
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
