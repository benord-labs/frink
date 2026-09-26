import { describe, expect, it } from 'vitest';
import {
  BOSS_STAGE,
  createGame,
  GEOMETRY,
  type Enemy,
  type GameInput,
  type GameState,
  START_LIVES,
  step,
  WORLD,
} from './bug-invaders';

const IDLE: GameInput = { left: false, right: false, fire: false };
const FIRE: GameInput = { left: false, right: false, fire: true };
const neverFire = () => 0.99;

function playing(overrides: Partial<GameState> = {}): GameState {
  return { ...createGame(), status: 'playing', bannerLeft: 0, enemyFireLeft: 99, ...overrides };
}

function run(state: GameState, input: GameInput, seconds: number, dt = 1 / 60): GameState {
  let s = state;
  for (let t = 0; t < seconds; t += dt) s = step(s, input, dt, neverFire);
  return s;
}

describe('Bug Invaders', () => {
  it('opens on the stage-1 banner with 30 lives, then starts play', () => {
    const game = createGame();
    expect(game.status).toBe('banner');
    expect(game.lives).toBe(START_LIVES);
    expect(game.enemies.length).toBeGreaterThan(0);
    expect(run(game, IDLE, 2.1).status).toBe('playing');
  });

  it('never mutates the previous state', () => {
    const before = playing();
    const snapshot = JSON.stringify(before);
    step(before, FIRE, 1 / 60, neverFire);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('keeps the ship inside the world', () => {
    const left = run(playing(), { ...IDLE, left: true }, 5);
    const right = run(playing(), { ...IDLE, right: true }, 5);
    expect(left.shipX).toBeGreaterThan(0);
    expect(right.shipX).toBeLessThan(WORLD.width);
  });

  it('limits fire to two shots in the air with a cooldown', () => {
    const s = run(playing({ enemies: [] }), FIRE, 0.35);
    expect(s.shots.length).toBeLessThanOrEqual(2);
  });

  it('scores a hit and removes the enemy', () => {
    const target: Enemy = { x: 400, y: 300, kind: 'bug' };
    const s = step(
      playing({
        enemies: [target, { ...target, x: 100, y: 80 }],
        shots: [{ x: 400, y: 310, vx: 0, vy: 0 }],
      }),
      IDLE,
      1 / 60,
      neverFire,
    );
    expect(s.score).toBe(100);
    expect(s.enemies).toHaveLength(1);
  });

  it('costs a life when hit, then protects the ship briefly', () => {
    const shot = { x: 400, y: GEOMETRY.SHIP.y - 10, vx: 0, vy: 0 };
    const hit = step(
      playing({ shipX: 400, enemyShots: [shot, { ...shot }] }),
      IDLE,
      1 / 60,
      neverFire,
    );
    expect(hit.lives).toBe(START_LIVES - 1);
    const again = step({ ...hit, enemyShots: [shot] }, IDLE, 1 / 60, neverFire);
    expect(again.lives).toBe(START_LIVES - 1);
  });

  it('ends the game when the last life goes', () => {
    const shot = { x: 400, y: GEOMETRY.SHIP.y - 10, vx: 0, vy: 0 };
    const s = step(playing({ shipX: 400, lives: 1, enemyShots: [shot] }), IDLE, 1 / 60, neverFire);
    expect(s.status).toBe('gameOver');
  });

  it('ends the game when the backlog reaches the ship', () => {
    const s = step(
      playing({ enemies: [{ x: 400, y: GEOMETRY.SHIP.y - 30, kind: 'bug' }] }),
      IDLE,
      1 / 60,
      neverFire,
    );
    expect(s.status).toBe('gameOver');
  });

  it('moves to the next stage banner once a wave is cleared', () => {
    const s = step(playing({ enemies: [] }), IDLE, 1 / 60, neverFire);
    expect(s.status).toBe('banner');
    expect(s.stage).toBe(2);
    expect(s.enemies.length).toBeGreaterThan(createGame().enemies.length);
  });

  it('brings on the boss at the last stage, and winning beats it', () => {
    const boss = step(playing({ stage: BOSS_STAGE - 1, enemies: [] }), IDLE, 1 / 60, neverFire);
    expect(boss.stage).toBe(BOSS_STAGE);
    expect(boss.boss?.hp).toBeGreaterThan(0);

    const nearlyBeaten = playing({
      stage: BOSS_STAGE,
      enemies: [],
      boss: { x: 400, hp: 1, t: 0, cooldown: 9 },
    });
    const s = step(
      { ...nearlyBeaten, shots: [{ x: 400, y: GEOMETRY.BOSS.y + 20, vx: 0, vy: 0 }] },
      IDLE,
      0,
      neverFire,
    );
    expect(s.status).toBe('won');
  });

  it('lets enemies fire back', () => {
    const s = step(playing({ enemyFireLeft: 0 }), IDLE, 1 / 60, () => 0);
    expect(s.enemyShots).toHaveLength(1);
  });
});
