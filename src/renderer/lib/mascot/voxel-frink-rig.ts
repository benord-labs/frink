import * as THREE from 'three';
import {
  buildVoxelFrink,
  CHALK_TIP_LOCAL,
  FRINK_BOX,
  FRINK_CANVAS,
  type FrinkBuild,
  type FrinkPose,
  MODEL_HEIGHT,
  type VoxelPartName,
} from './voxel-frink-model';

const OFFSET_X = (FRINK_CANVAS.width - FRINK_BOX.width) / 2;
const OFFSET_Y = (FRINK_CANVAS.height - FRINK_BOX.height) / 2;

const ASSEMBLE_MS = 1200;

type PoseAngles = {
  armL: number;
  armR: number;
  armX: number;
  headX: number;
  headZ: number;
  turn: number;
  /** Leg and arm swing amplitude, in radians. */
  stride: number;
};

// A `turn` near π puts his back to the viewer so he faces the board.
const POSES = {
  stand: { armL: -0.1, armR: 0.1, armX: 0, headX: 0, headZ: 0, turn: 0, stride: 0 },
  write: {
    armL: -0.2,
    armR: 2.75,
    armX: -0.45,
    headX: -0.3,
    headZ: 0.05,
    turn: Math.PI - 0.35,
    stride: 0,
  },
  cheer: { armL: -2.7, armR: 2.7, armX: 0, headX: -0.12, headZ: 0, turn: 0, stride: 0 },
  // Three-quarter turn to his left, so he strides rightward across the screen.
  walk: { armL: -0.1, armR: 0.1, armX: 0, headX: 0, headZ: 0, turn: 0.9, stride: 0.6 },
} satisfies Record<FrinkPose, PoseAngles>;

function blendAngles(from: PoseAngles, to: PoseAngles, amount: number): PoseAngles {
  const mix = (a: number, b: number) => a + (b - a) * amount;
  return {
    armL: mix(from.armL, to.armL),
    armR: mix(from.armR, to.armR),
    armX: mix(from.armX, to.armX),
    headX: mix(from.headX, to.headX),
    headZ: mix(from.headZ, to.headZ),
    turn: mix(from.turn, to.turn),
    stride: mix(from.stride, to.stride),
  };
}

const HEAD_SCALE = 1.22;
const FLASH = new THREE.Color(0x7ef9ff);

type AnimatedVoxel = {
  home: THREE.Vector3;
  color: THREE.Color;
  scatter: THREE.Vector3;
  spin: THREE.Vector3;
  row: number;
  /** Last rendered build progress, so an explode starts from wherever the cube is. */
  progress: number;
  explodeFrom: number;
};

type PartMesh = { mesh: THREE.InstancedMesh; voxels: AnimatedVoxel[] };

export type VoxelFrinkRig = {
  /** Lights plus the posable model; mount it in a scene. */
  object: THREE.Group;
  setPose: (pose: FrinkPose) => void;
  setBuild: (build: FrinkBuild) => void;
  /**
   * Advances one frame. Returns where the chalk tip sits, in CSS px relative to
   * the top-left of FRINK_BOX, measured before the writing wiggle.
   */
  update: (now: number, dt: number, camera: THREE.Camera) => BoxPoint;
  dispose: () => void;
};

/** Faint border on every cube face so the voxels read as crafted blocks, not a smooth mesh. */
function createEdgeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#e4e4e4';
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#ffffff';
    g.fillRect(1, 1, 14, 14);
  }
  const texture = new THREE.CanvasTexture(c);
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type Vec3 = [number, number, number];
const CAMERA_POSITION: Vec3 = [32, 33, 98];
const CAMERA_TARGET: Vec3 = [0, 18, 0];

/** A point in CSS px relative to the top-left of FRINK_BOX. */
type BoxPoint = { x: number; y: number };

type BuiltParts = { groups: PartGroups; meshes: PartMesh[] };

// Widen the field of view with the canvas so Frink keeps his on-screen size.
const BOX_HALF_FOV = (11 * Math.PI) / 180;
export const FRINK_CAMERA = {
  fov:
    (2 * Math.atan(Math.tan(BOX_HALF_FOV) * (FRINK_CANVAS.height / FRINK_BOX.height)) * 180) /
    Math.PI,
  near: 1,
  far: 400,
  position: CAMERA_POSITION,
  lookAt: CAMERA_TARGET,
};

function addLights(into: THREE.Group) {
  into.add(new THREE.HemisphereLight(0xdfe4ff, 0x3a2d55, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(-30, 50, 60);
  const rim = new THREE.DirectionalLight(0xb48cff, 1.6);
  rim.position.set(40, 20, -50);
  into.add(key, rim);
}

function createPartGroups() {
  return {
    body: new THREE.Group(),
    head: new THREE.Group(),
    eyes: new THREE.Group(),
    armL: new THREE.Group(),
    armR: new THREE.Group(),
    legL: new THREE.Group(),
    legR: new THREE.Group(),
    chalk: new THREE.Group(),
  } satisfies Record<VoxelPartName, THREE.Group>;
}

type PartGroups = ReturnType<typeof createPartGroups>;

function buildParts(
  root: THREE.Group,
  geometry: THREE.BoxGeometry,
  material: THREE.Material,
): BuiltParts {
  const groups = createPartGroups();
  const parts = buildVoxelFrink();
  const meshes: PartMesh[] = [];
  for (const part of parts) {
    const [px, py, pz] = part.pivot;
    const parent = parts.find((p) => p.name === part.parent);
    const [qx, qy, qz] = parent ? parent.pivot : [0, 0, 0];
    const group = groups[part.name];
    group.position.set(px - qx, py - qy, pz - qz);
    (parent ? groups[parent.name] : root).add(group);

    const mesh = new THREE.InstancedMesh(geometry, material, part.voxels.length);
    const voxels = part.voxels.map((v, i) => {
      const color = new THREE.Color(v.color);
      mesh.setColorAt(i, color);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5);
      return {
        home: new THREE.Vector3(v.x - px, v.y - py, v.z - pz),
        color,
        scatter: dir.normalize().multiplyScalar(18 + Math.random() * 26),
        spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        row: v.y,
        progress: 0,
        explodeFrom: 0,
      };
    });
    group.add(mesh);
    meshes.push({ mesh, voxels });
  }
  groups.head.scale.setScalar(HEAD_SCALE);
  groups.chalk.visible = false;
  return { groups, meshes };
}

export function createVoxelFrinkRig(): VoxelFrinkRig {
  const object = new THREE.Group();
  addLights(object);
  const texture = createEdgeTexture();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.82,
    metalness: 0,
    transparent: true,
  });
  const root = new THREE.Group();
  object.add(root);
  const { groups, meshes } = buildParts(root, geometry, material);

  let pose: FrinkPose = 'stand';
  let angles: PoseAngles = POSES.stand;
  let build: FrinkBuild = 'hidden';
  // The last still state written to the buffers; still states are written once, not every frame.
  let written: FrinkBuild | null = null;
  let buildStart = 0;
  let blinkUntil = 0;
  let nextBlink = 0;

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const tint = new THREE.Color();
  const tip = new THREE.Vector3();

  function voxelProgress(v: AnimatedVoxel, t: number): number {
    if (build === 'hidden') return 0;
    if (build === 'assemble') return clamp01((t - (v.row / MODEL_HEIGHT) * 520) / 420);
    if (build === 'explode') {
      return Math.min(v.explodeFrom, 1 - clamp01((t - (MODEL_HEIGHT - v.row) * 14) / 700));
    }
    return 1;
  }

  function applyBuild(now: number) {
    const t = now - buildStart;
    for (const { mesh, voxels } of meshes) {
      voxels.forEach((v, i) => {
        const k = voxelProgress(v, t);
        v.progress = k;
        const ease = 1 - (1 - k) ** 3;
        const loose = 1 - k;
        pos
          .copy(v.scatter)
          .multiplyScalar(1 - ease)
          .add(v.home);
        if (build === 'explode') pos.y += loose * loose * 12;
        euler.set(v.spin.x * loose, v.spin.y * loose, v.spin.z * loose);
        quat.setFromEuler(euler);
        const size = k <= 0 ? 0 : 0.2 + 0.8 * ease;
        scale.set(size, size, size);
        mesh.setMatrixAt(i, matrix.compose(pos, quat, scale));
        mesh.setColorAt(i, tint.copy(v.color).lerp(FLASH, Math.min(1, loose * 1.2)));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    material.opacity =
      build === 'assemble'
        ? Math.min(1, t / 700)
        : build === 'explode'
          ? Math.max(0, 1 - t / 950)
          : 1;
  }

  function poseRig(now: number, dt: number) {
    angles = blendAngles(angles, POSES[pose], 1 - 0.0005 ** dt);
    const s = now / 1000;
    const swing = Math.sin(s * 10) * angles.stride;
    groups.legL.rotation.x = swing;
    groups.legR.rotation.x = -swing;
    groups.armR.rotation.set(angles.armX - swing * 0.7, 0, angles.armR);
    groups.armL.rotation.x = swing * 0.7;
    groups.armL.rotation.z =
      angles.armL + (pose === 'cheer' ? Math.sin(s * 9) * 0.15 : Math.sin(s * 1.6) * 0.03);
    groups.head.rotation.x = angles.headX + Math.sin(s * 1.3) * 0.03;
    groups.head.rotation.z = angles.headZ + Math.sin(s * 0.9) * 0.04;
    root.rotation.y = angles.turn + (pose === 'write' ? 0 : Math.sin(s * 0.7) * 0.06);
    root.position.y =
      (pose === 'cheer' ? Math.abs(Math.sin(s * 9)) * 1.6 : 0) +
      Math.abs(swing) * 0.6 +
      Math.sin(s * 2) * 0.18;
    if (now > nextBlink) {
      blinkUntil = now + 130;
      nextBlink = now + 2200 + Math.random() * 2600;
    }
    groups.eyes.scale.y = now < blinkUntil ? 0.15 : 1;
  }

  function measureTip(camera: THREE.Camera): BoxPoint {
    root.updateMatrixWorld(true);
    tip.set(...CHALK_TIP_LOCAL);
    groups.chalk.localToWorld(tip).project(camera);
    return {
      x: ((tip.x + 1) / 2) * FRINK_CANVAS.width - OFFSET_X,
      y: ((1 - tip.y) / 2) * FRINK_CANVAS.height - OFFSET_Y,
    };
  }

  return {
    object,
    setPose(next) {
      pose = next;
      groups.chalk.visible = next === 'write';
    },
    setBuild(next) {
      if (next === 'explode') {
        for (const { voxels } of meshes) for (const v of voxels) v.explodeFrom = v.progress;
      }
      build = next;
      buildStart = performance.now();
      written = null;
    },
    update(now, dt, camera) {
      if (build === 'assemble' && now - buildStart > ASSEMBLE_MS) build = 'solid';
      const still = build === 'solid' || build === 'hidden';
      if (!still || written !== build) applyBuild(now);
      written = still ? build : null;
      poseRig(now, dt);
      const at = measureTip(camera);
      // The wrist wiggle is applied after measuring so it never drags the body around.
      if (pose === 'write') {
        groups.armR.rotation.z += Math.sin((now / 1000) * 19) * 0.05;
        groups.armR.rotation.x += Math.cos((now / 1000) * 19) * 0.04;
      }
      return at;
    },
    dispose() {
      for (const { mesh } of meshes) mesh.dispose();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
