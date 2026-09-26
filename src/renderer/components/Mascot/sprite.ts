const PALETTE = [
  '',
  '#7c4dba',
  '#f4c28a',
  '#3a6bc5',
  '#eef0f5',
  '#c5c8d4',
  '#3d3d5c',
  '#222236',
  '#e84040',
];

const W = 12;
const H = 18;
const SCALE = 6;

// 12x18 pixel scientist — each char is a palette index
// 0=transparent 1=hair 2=skin 3=glasses 4=coat 5=coat-shadow 6=pants 7=shoes 8=tie
const FRAME_SHARED_TOP = [
  '000111110000',
  '001111111000',
  '001111111000',
  '000222222000',
  '000323323000',
  '000222222000',
  '000022220000',
  '004444844400',
  '044454845440',
  '044454445440',
  '044444444440',
  '004444444400',
];

const FRAME_WALK_A_LEGS = [
  '000066660000',
  '000660006000',
  '000660000600',
  '000660000600',
  '000770000700',
  '000770000700',
];

const FRAME_WALK_B_LEGS = [
  '000066660000',
  '000600066000',
  '006000066000',
  '006000066000',
  '007000077000',
  '007000077000',
];

const FRAME_STAND_LEGS = [
  '000066660000',
  '000066660000',
  '000060060000',
  '000060060000',
  '000070070000',
  '000070070000',
];

function renderFrame(rows: string[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }

  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const idx = Number(rows[y][x]);
      if (idx === 0) continue;
      ctx.fillStyle = PALETTE[idx];
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return canvas;
}

export type SpriteFrames = {
  right: [HTMLCanvasElement, HTMLCanvasElement, HTMLCanvasElement];
  width: number;
  height: number;
};

export function createSpriteFrames(): SpriteFrames {
  const standR = renderFrame([...FRAME_SHARED_TOP, ...FRAME_STAND_LEGS]);
  const walkAR = renderFrame([...FRAME_SHARED_TOP, ...FRAME_WALK_A_LEGS]);
  const walkBR = renderFrame([...FRAME_SHARED_TOP, ...FRAME_WALK_B_LEGS]);

  return {
    right: [walkAR, standR, walkBR],
    width: W * SCALE,
    height: H * SCALE,
  };
}
