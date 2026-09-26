import { type EnemyKind, type GameState, GEOMETRY, WORLD } from './bug-invaders';

/** The slice of a 2D context the game draws with. */
export type GameContext = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'drawImage'
  | 'fillRect'
  | 'fillStyle'
  | 'globalAlpha'
  | 'imageSmoothingEnabled'
  | 'restore'
  | 'save'
  | 'setTransform'
>;

/** Illustration pigments, like the voxel and chalkboard colours; not app theme tokens. */
const INK = {
  bug: '#7ef9ff',
  conflict: '#ff78e6',
  ship: '#b48cff',
  shot: '#f1efe6',
  enemyShot: '#ff5c5c',
  hpBack: '#3d3d5c',
  hp: '#e84040',
};

// 1 marks a filled pixel.
const BITMAPS = {
  bug: [
    '000100001000',
    '000010010000',
    '000111111000',
    '001101101100',
    '011111111110',
    '010111111010',
    '010100001010',
    '000011110000',
  ],
  conflict: [
    '001100001100',
    '011000000110',
    '110011110011',
    '110011110011',
    '011000000110',
    '001100001100',
  ],
  ship: [
    '0000001000000',
    '0000011100000',
    '0000011100000',
    '0111111111110',
    '1111111111111',
    '1111111111111',
    '1100000000011',
  ],
} satisfies Record<EnemyKind | 'ship', string[]>;

function drawBitmap(ctx: GameContext, rows: string[], cx: number, top: number, width: number) {
  const px = width / (rows[0]?.length ?? 1);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') ctx.fillRect(cx - width / 2 + x * px, top + y * px, px, px);
    }
  });
}

/** Maps the 800x600 world onto the canvas, centred and letterboxed. */
function worldTransform(view: { width: number; height: number }) {
  const scale = Math.min(view.width / WORLD.width, view.height / WORLD.height) * 0.92;
  return {
    scale,
    x: (view.width - WORLD.width * scale) / 2,
    y: (view.height - WORLD.height * scale) / 2,
  };
}

function drawBoss(ctx: GameContext, s: GameState, sprite: CanvasImageSource | null) {
  if (!s.boss) return;
  const { BOSS } = GEOMETRY;
  if (sprite) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite, s.boss.x - BOSS.width / 2, BOSS.y, BOSS.width, BOSS.height);
  }
  const barWidth = 240;
  ctx.fillStyle = INK.hpBack;
  ctx.fillRect(WORLD.width / 2 - barWidth / 2, 28, barWidth, 8);
  ctx.fillStyle = INK.hp;
  ctx.fillRect(
    WORLD.width / 2 - barWidth / 2,
    28,
    (barWidth * Math.max(0, s.boss.hp)) / BOSS.hp,
    8,
  );
}

/** Draws one frame; `bossSprite` is the pixel Frink, and `blinkOff` hides an invulnerable ship. */
export function drawGame(
  ctx: GameContext,
  s: GameState,
  view: { width: number; height: number },
  bossSprite: CanvasImageSource | null,
  blinkOff: boolean,
) {
  const { SHIP, ENEMY } = GEOMETRY;
  const t = worldTransform(view);
  ctx.save();
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.setTransform(t.scale, 0, 0, t.scale, t.x, t.y);

  for (const e of s.enemies) {
    ctx.fillStyle = INK[e.kind];
    drawBitmap(ctx, BITMAPS[e.kind], e.x, e.y, ENEMY.width);
  }
  drawBoss(ctx, s, bossSprite);

  ctx.fillStyle = INK.shot;
  for (const shot of s.shots) ctx.fillRect(shot.x - 2, shot.y, 4, 12);
  ctx.fillStyle = INK.enemyShot;
  for (const shot of s.enemyShots) ctx.fillRect(shot.x - 3, shot.y, 6, 10);

  if (s.status !== 'gameOver' && !(blinkOff && s.invulnerableLeft > 0)) {
    ctx.fillStyle = INK.ship;
    drawBitmap(ctx, BITMAPS.ship, s.shipX, SHIP.y - 24, SHIP.width);
  }
  ctx.restore();
}
