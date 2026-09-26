/** Bug Invaders, the Konami game: plain data plus a pure step, so the rules are testable
 * without a canvas. Coordinates are a fixed 800x600 world the renderer scales to fit. */

export const WORLD = { width: 800, height: 600 };
export const BOSS_STAGE = 5;
export const START_LIVES = 30;

const SHIP = { y: 560, width: 40, speed: 360 };
const SHOT = { speed: 520, cooldown: 0.3, max: 2 };
const ENEMY = { width: 36, height: 24, gapX: 20, gapY: 18, top: 70, drop: 22 };
const ENEMY_SHOT_SPEED = 220;
const BOSS = { width: 72, height: 108, y: 60, hp: 40, fireEvery: 0.8 };
const INVULNERABLE_S = 1.5;
const BANNER_S = 2;

export type EnemyKind = 'bug' | 'conflict';
export type Enemy = { x: number; y: number; kind: EnemyKind };
type Shot = { x: number; y: number; vx: number; vy: number };
type Boss = { x: number; hp: number; t: number; cooldown: number };
export type GameStatus = 'banner' | 'playing' | 'gameOver' | 'won';

export type GameState = {
  status: GameStatus;
  stage: number;
  /** Seconds left on the stage banner. */
  bannerLeft: number;
  score: number;
  lives: number;
  shipX: number;
  invulnerableLeft: number;
  shotCooldown: number;
  shots: Shot[];
  enemyShots: Shot[];
  enemies: Enemy[];
  /** +1 marching right, -1 left. */
  march: 1 | -1;
  enemyFireLeft: number;
  boss: Boss | null;
};

export type GameInput = { left: boolean; right: boolean; fire: boolean };
export type Rng = () => number;

const POINTS = { bug: 100, conflict: 150 } satisfies Record<EnemyKind, number>;

function formation(stage: number): Enemy[] {
  const rows = Math.min(2 + stage, 6);
  const cols = 9;
  const rowWidth = cols * ENEMY.width + (cols - 1) * ENEMY.gapX;
  const left = (WORLD.width - rowWidth) / 2;
  const enemies: Enemy[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      enemies.push({
        x: left + c * (ENEMY.width + ENEMY.gapX),
        y: ENEMY.top + r * (ENEMY.height + ENEMY.gapY),
        kind: r % 2 === 0 ? 'conflict' : 'bug',
      });
    }
  }
  return enemies;
}

function stageSetup(
  stage: number,
): Pick<GameState, 'enemies' | 'boss' | 'march' | 'enemyFireLeft'> {
  if (stage === BOSS_STAGE) {
    return {
      enemies: [],
      boss: { x: WORLD.width / 2, hp: BOSS.hp, t: 0, cooldown: 1 },
      march: 1,
      enemyFireLeft: 1,
    };
  }
  return { enemies: formation(stage), boss: null, march: 1, enemyFireLeft: 1 };
}

export function createGame(): GameState {
  return {
    status: 'banner',
    stage: 1,
    bannerLeft: BANNER_S,
    score: 0,
    lives: START_LIVES,
    shipX: WORLD.width / 2,
    invulnerableLeft: 0,
    shotCooldown: 0,
    shots: [],
    enemyShots: [],
    ...stageSetup(1),
  };
}

function overlaps(shot: Shot, x: number, y: number, width: number, height: number): boolean {
  return shot.x >= x - width / 2 && shot.x <= x + width / 2 && shot.y >= y && shot.y <= y + height;
}

function moveShots(shots: Shot[], dt: number): Shot[] {
  return shots
    .map((s) => ({ ...s, x: s.x + s.vx * dt, y: s.y + s.vy * dt }))
    .filter((s) => s.y > -20 && s.y < WORLD.height + 20);
}

function marchSpeed(stage: number, remaining: number, total: number): number {
  return (40 + stage * 18) * (1 + (1 - remaining / Math.max(total, 1)) * 2);
}

function marchEnemies(s: GameState, dt: number): void {
  const speed = marchSpeed(s.stage, s.enemies.length, formation(s.stage).length);
  const moved = s.enemies.map((e) => ({ ...e, x: e.x + speed * s.march * dt }));
  const hitsEdge = moved.some(
    (e) => e.x < ENEMY.width / 2 + 10 || e.x > WORLD.width - ENEMY.width / 2 - 10,
  );
  if (hitsEdge) {
    s.march = s.march === 1 ? -1 : 1;
    s.enemies = s.enemies.map((e) => ({ ...e, y: e.y + ENEMY.drop }));
  } else {
    s.enemies = moved;
  }
}

/** A random enemy from the lowest row of each column fires. */
function enemyFire(s: GameState, dt: number, rng: Rng): void {
  s.enemyFireLeft -= dt;
  if (s.enemyFireLeft > 0 || s.enemies.length === 0) return;
  s.enemyFireLeft = Math.max(0.35, 1.3 - s.stage * 0.18);
  const lowest = new Map<number, Enemy>();
  for (const e of s.enemies) {
    const col = Math.round(e.x);
    const current = lowest.get(col);
    if (!current || e.y > current.y) lowest.set(col, e);
  }
  const shooters = [...lowest.values()];
  const shooter = shooters[Math.floor(rng() * shooters.length)];
  if (shooter) {
    s.enemyShots.push({ x: shooter.x, y: shooter.y + ENEMY.height, vx: 0, vy: ENEMY_SHOT_SPEED });
  }
}

function stepBoss(s: GameState, dt: number): void {
  const boss = s.boss;
  if (!boss) return;
  const t = boss.t + dt;
  const x = WORLD.width / 2 + Math.sin(t * 0.9) * (WORLD.width / 2 - BOSS.width);
  let cooldown = boss.cooldown - dt;
  if (cooldown <= 0) {
    cooldown = BOSS.fireEvery;
    for (const vx of [-90, 0, 90]) {
      s.enemyShots.push({ x, y: BOSS.y + BOSS.height, vx, vy: ENEMY_SHOT_SPEED });
    }
  }
  s.boss = { ...boss, x, t, cooldown };
}

/** Player shots against enemies and the boss; returns the shots still flying. */
function resolvePlayerHits(s: GameState): void {
  const survivors: Shot[] = [];
  for (const shot of s.shots) {
    const hit = s.enemies.findIndex((e) => overlaps(shot, e.x, e.y, ENEMY.width, ENEMY.height));
    if (hit !== -1) {
      s.score += POINTS[s.enemies[hit]?.kind ?? 'bug'];
      s.enemies = s.enemies.filter((_, i) => i !== hit);
      continue;
    }
    if (s.boss && overlaps(shot, s.boss.x, BOSS.y, BOSS.width, BOSS.height)) {
      s.boss = { ...s.boss, hp: s.boss.hp - 1 };
      s.score += 50;
      continue;
    }
    survivors.push(shot);
  }
  s.shots = survivors;
}

function resolveShipHits(s: GameState): void {
  if (s.invulnerableLeft > 0) return;
  const hit = s.enemyShots.some((shot) => overlaps(shot, s.shipX, SHIP.y - 12, SHIP.width, 24));
  if (!hit) return;
  s.lives -= 1;
  s.invulnerableLeft = INVULNERABLE_S;
  s.enemyShots = [];
  if (s.lives <= 0) s.status = 'gameOver';
}

function finishStage(s: GameState): void {
  if (s.boss && s.boss.hp <= 0) {
    s.score += 5000;
    s.status = 'won';
    return;
  }
  if (s.stage < BOSS_STAGE && s.enemies.length === 0) {
    s.stage += 1;
    s.status = 'banner';
    s.bannerLeft = BANNER_S;
    s.shots = [];
    s.enemyShots = [];
    Object.assign(s, stageSetup(s.stage));
    return;
  }
  // The backlog reached the ship: game over whatever the lives.
  if (s.enemies.some((e) => e.y + ENEMY.height >= SHIP.y - 24)) s.status = 'gameOver';
}

/** Advances the game by `dt` seconds. Returns a new state; never mutates `prev`. */
export function step(
  prev: GameState,
  input: GameInput,
  dt: number,
  rng: Rng = Math.random,
): GameState {
  const s: GameState = { ...prev, shots: [...prev.shots], enemyShots: [...prev.enemyShots] };
  if (s.status === 'gameOver' || s.status === 'won') return s;
  if (s.status === 'banner') {
    s.bannerLeft -= dt;
    if (s.bannerLeft <= 0) s.status = 'playing';
    return s;
  }

  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  s.shipX = Math.min(
    WORLD.width - SHIP.width,
    Math.max(SHIP.width, s.shipX + dir * SHIP.speed * dt),
  );
  s.shotCooldown = Math.max(0, s.shotCooldown - dt);
  s.invulnerableLeft = Math.max(0, s.invulnerableLeft - dt);
  if (input.fire && s.shotCooldown === 0 && s.shots.length < SHOT.max) {
    s.shots.push({ x: s.shipX, y: SHIP.y - 24, vx: 0, vy: -SHOT.speed });
    s.shotCooldown = SHOT.cooldown;
  }

  s.shots = moveShots(s.shots, dt);
  s.enemyShots = moveShots(s.enemyShots, dt);
  marchEnemies(s, dt);
  enemyFire(s, dt, rng);
  stepBoss(s, dt);
  resolvePlayerHits(s);
  resolveShipHits(s);
  if (s.status === 'playing') finishStage(s);
  return s;
}

export const GEOMETRY = { SHIP, ENEMY, BOSS };
