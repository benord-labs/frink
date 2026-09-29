/** Voxel Frink as plain data: each cube's position and colour, grouped into parts
 * that pivot independently. No three.js here, so the shape is testable. */

export type FrinkPose = 'stand' | 'write' | 'cheer' | 'walk';
export type FrinkBuild = 'hidden' | 'assemble' | 'solid' | 'explode';

/** On-screen box Frink stands in, in CSS px. Lives here, not in the rig, so
 * eager code can size Frink without pulling three.js out of the lazy chunk. */
export const FRINK_BOX = { width: 160, height: 196 } as const;
/** The WebGL canvas is far larger than the box and centred on it, so flying cubes never hit an edge. */
export const FRINK_CANVAS = { width: 480, height: 520 } as const;

export type VoxelPartName = 'body' | 'head' | 'eyes' | 'armL' | 'armR' | 'legL' | 'legR' | 'chalk';

type Voxel = { x: number; y: number; z: number; color: number };

export type VoxelPart = {
  name: VoxelPartName;
  /** Rotation origin in model space. */
  pivot: readonly [number, number, number];
  /** The part this one rotates with; null means the model root. */
  parent: VoxelPartName | null;
  voxels: Voxel[];
};

const C = {
  skin: 0xf4c28a,
  skinShade: 0xe2a56d,
  hair: 0x7c4dba,
  hairLight: 0xa37be0,
  hairDark: 0x5d3791,
  frame: 0x2b2b45,
  lens: 0xd6efff,
  pupil: 0x16162a,
  coat: 0xf2f3f7,
  coatShade: 0xc9ccd8,
  shirt: 0xcfdcf0,
  tie: 0xe84040,
  tieDark: 0xb52c2c,
  pants: 0x3d3d5c,
  shoe: 0x222236,
  pen: 0x3a6bc5,
  mouth: 0x7a3b2e,
  teeth: 0xffffff,
  chalk: 0xf6f4ea,
} as const;

/** Parents come before children so a builder can create groups in order. */
const PART_LAYOUT: ReadonlyArray<Omit<VoxelPart, 'voxels'>> = [
  { name: 'body', pivot: [0, 0, 0], parent: null },
  { name: 'head', pivot: [0, 16, 0], parent: null },
  { name: 'eyes', pivot: [0, 21.5, 5], parent: 'head' },
  { name: 'armL', pivot: [-5.5, 15, -0.5], parent: null },
  { name: 'armR', pivot: [5.5, 15, -0.5], parent: null },
  { name: 'legL', pivot: [-2, 5, 0], parent: null },
  { name: 'legR', pivot: [2, 5, 0], parent: null },
  { name: 'chalk', pivot: [5.5, 15, -0.5], parent: 'armR' },
];

/** The chalk's writing end, in the chalk part's local space (relative to its pivot). */
export const CHALK_TIP_LOCAL: readonly [number, number, number] = [-0.5, -12.5, 0.5];

/** Tallest voxel row; drives the bottom-up assemble and top-down explode order. */
export const MODEL_HEIGHT = 31;

type Grid = Map<string, Voxel>;

function put(grid: Grid, x: number, y: number, z: number, color: number) {
  grid.set(`${x},${y},${z}`, { x, y, z, color });
}

type Paint = (x: number, y: number, z: number) => number;

function solid(color: number): Paint {
  return () => color;
}

function box(
  grid: Grid,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
  [z0, z1]: [number, number],
  paint: Paint,
) {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) put(grid, x, y, z, paint(x, y, z));
    }
  }
}

/** Legs are their own parts, hinged at the hip, so the walk can swing them. */
function buildLeg(g: Grid, x0: number) {
  box(g, [x0, x0 + 2], [0, 1], [-1, 2], solid(C.shoe));
  box(g, [x0, x0 + 2], [2, 4], [-1, 1], solid(C.pants));
}

function buildBody(g: Grid) {
  box(g, [-4, 4], [5, 15], [-2, 2], (x, _y, z) =>
    Math.abs(x) === 4 || z === -2 ? C.coatShade : C.coat,
  );
  box(g, [-1, 1], [9, 15], [2, 2], solid(C.shirt));
  for (let y = 11; y <= 15; y++) {
    put(g, -2, y, 2, C.coatShade);
    put(g, 2, y, 2, C.coatShade);
  }
  box(g, [0, 0], [9, 14], [3, 3], solid(C.tie));
  put(g, 0, 15, 3, C.tieDark);
  box(g, [2, 3], [10, 10], [3, 3], solid(C.coatShade));
  box(g, [3, 3], [11, 12], [3, 3], solid(C.pen));
  box(g, [-1, 1], [16, 16], [-1, 1], solid(C.skinShade));
}

const HAIR_SPIKES: ReadonlyArray<[number, number, number]> = [
  [-3, 28, 0],
  [-3, 29, -1],
  [-1, 28, 1],
  [0, 28, -1],
  [0, 29, -1],
  [0, 30, -2],
  [0, 31, -2],
  [2, 28, 0],
  [3, 28, -2],
  [3, 29, -2],
  [4, 30, -2],
  [-5, 28, -1],
  [-6, 27, -1],
  [-6, 28, -2],
  [-7, 29, -2],
  [5, 28, -1],
  [6, 27, -1],
  [6, 28, -2],
  [7, 29, -2],
  [-6, 24, -2],
  [6, 24, -2],
  [-6, 23, -3],
  [6, 23, -3],
  [-2, 28, -3],
  [1, 28, 2],
  [2, 29, 1],
];

function buildHead(g: Grid) {
  box(g, [-4, 4], [17, 25], [-3, 4], solid(C.skin));
  box(g, [-5, -5], [19, 21], [0, 1], solid(C.skinShade));
  box(g, [5, 5], [19, 21], [0, 1], solid(C.skinShade));
  box(g, [-4, 4], [26, 27], [-3, 3], (x, y) =>
    y === 27 && (x + 7) % 3 === 0 ? C.hairLight : C.hair,
  );
  box(g, [-4, 4], [18, 25], [-4, -4], solid(C.hairDark));
  box(g, [-5, -5], [22, 27], [-3, -1], solid(C.hair));
  box(g, [5, 5], [22, 27], [-3, -1], solid(C.hair));
  for (let x = -4; x <= 4; x++) if (Math.abs(x) !== 1) put(g, x, 25, 4, C.hair);
  put(g, -4, 24, 4, C.hair);
  put(g, 4, 24, 4, C.hair);
  HAIR_SPIKES.forEach(([x, y, z], i) => put(g, x, y, z, i % 3 === 0 ? C.hairLight : C.hair));
  // Buck-toothed grin, big nose, oversized glasses.
  box(g, [-2, 2], [18, 18], [4, 4], solid(C.mouth));
  box(g, [-1, 0], [17, 18], [5, 5], solid(C.teeth));
  box(g, [0, 0], [19, 20], [5, 6], solid(C.skinShade));
  for (const [x0, x1] of [
    [-4, -1],
    [1, 4],
  ] as const) {
    box(g, [x0, x1], [20, 23], [5, 5], (x, y) =>
      x === x0 || x === x1 || y === 20 || y === 23 ? C.frame : C.lens,
    );
  }
  put(g, 0, 22, 5, C.frame);
  box(g, [-5, -5], [22, 22], [1, 4], solid(C.frame));
  box(g, [5, 5], [22, 22], [1, 4], solid(C.frame));
  // The pupils live in their own part so blinking can squash them.
  g.delete('-2,21,5');
  g.delete('2,21,5');
}

function buildArm(g: Grid, x0: number) {
  box(g, [x0, x0 + 1], [8, 15], [-1, 0], (_x, y) => (y === 8 ? C.coatShade : C.coat));
  box(g, [x0, x0 + 1], [6, 7], [-1, 0], solid(C.skin));
}

const BUILDERS = {
  body: buildBody,
  head: buildHead,
  eyes: (g) => {
    put(g, -2, 21, 5, C.pupil);
    put(g, 2, 21, 5, C.pupil);
  },
  armL: (g) => buildArm(g, -6),
  armR: (g) => buildArm(g, 5),
  legL: (g) => buildLeg(g, -3),
  legR: (g) => buildLeg(g, 1),
  chalk: (g) => box(g, [5, 5], [3, 5], [0, 0], solid(C.chalk)),
} satisfies Record<VoxelPartName, (g: Grid) => void>;

export function buildVoxelFrink(): VoxelPart[] {
  return PART_LAYOUT.map((layout) => {
    const grid: Grid = new Map();
    BUILDERS[layout.name](grid);
    return { ...layout, voxels: [...grid.values()] };
  });
}
