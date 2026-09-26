import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as Three from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

/**
 * The Frink mark as two SVG paths — same geometry as `FrinkLoadingLogo` and
 * `src/renderer/index.html`. The mark itself IS the 3D object. Keep in sync.
 *
 * Direction: EDGE-FIRST MATERIALIZE. The mark MOUNTS front-on (rotation [0,0,0]) so
 * its footprint registers with the flat 2D outline the shell fades out over it, and
 * it holds that pose — edges lit, body hidden — until the parent flips `active` (the
 * swap is underway). Then a deterministic, time-based entrance runs: the extruded
 * EDGES are the just-drawn violet outline, the lit body opacity ramps 0→1 so the
 * outline "fills" into a solid, and only then does it ease into the resting tilt +
 * idle tumble. One mark gaining depth in place — no crossfade of misaligned images.
 * Edges stay depth-tested with no additive blend (additive inverts on the white theme).
 */
const FRINK_SVG =
  '<svg viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg"><path d="M350.3 166.97L244.64 229.85C237.67 234 233.44 241.34 233.46 249.24C233.59 291.18 233.7 333.12 233.84 375.04L149.69 426.42V219.37C149.69 204.69 157.5 191.03 170.37 183.19L350.3 73.59V166.97Z"/><path d="M350.3 199.41V285.79L260.18 340.79V263.8C260.18 257.46 263.57 251.57 269.15 248.22L350.3 199.41Z"/></svg>';

// Brand violet in the Frink family. A solid, lit object — reads on near-black AND
// white. The trace + the entering edges share this hue so the line is continuous.
const MARK_COLOR = '#7c5cff';
const EDGE_COLOR = '#a78bff';

// The mark is flat (depth 36 vs ~200 wide). A full Y-spin presents the thin sliver
// edge-on and reads as broken, so yaw is bounded and the base nod is deep enough
// that even the swing extremes keep the lit face and bevels toward the camera.
const Y_SWING = 0.4; // rad
const BASE_TILT_X = -0.18; // a clear nod so the extruded depth and bevels register
const BASE_TILT_Z = 0.04;

// Entrance schedule (seconds), measured from the moment `active` flips true — i.e. when
// the shell begins the outline→3D swap. Driven off a delta-accumulated ref so a headless
// screenshot at a known time renders the right frame.
//
// EDGE_HOLD keeps only the edges visible, front-on — visually the drawn outline, so the
// swap lands on a coincident image. BODY_FILL ramps body opacity 0→1 (the outline fills
// into a solid). TILT_SETTLE then eases [0,0,0] into the resting tilt and ramps the idle
// tumble amplitude 0→1, so depth and motion arrive together, in place.
const EDGE_HOLD = 0.45;
const BODY_FILL = 1.1;
const TILT_SETTLE = 1.6;
// Resting edge opacity once filled — a faint depth-tested crisp on the bevels.
const EDGE_REST_OPACITY = 0.25;

// EdgesGeometry threshold (deg). The entering edge line IS the swap image — it must read
// as the clean 2-path 2D outline the trace just drew. A low threshold (~22) also emits the
// bevel-segment and interior edges, so the wireframe looks busier than the 2D stroke and
// fails to register at the dissolve frame. ~48 keeps only the sharp silhouette profile, so
// the entering line matches the drawn outline near pixel-for-pixel.
const EDGE_THRESHOLD = 48;

// ease-out quint — premium settle, no overshoot/bounce/elastic. Exported for unit tests;
// callers always feed it clamp01'd input, so it is only meaningful on [0,1].
export function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export type MarkFrame = {
  rotation: [number, number, number];
  bodyOpacity: number;
  edgeOpacity: number;
};

// Pure per-frame entrance/idle solve (no Three refs) so the whole timeline is unit-testable.
// !active → the held mount pose: front-on [0,0,0], edges lit (1), body hidden (0). active → the
// body fills edges-first (held at 0 through EDGE_HOLD, then eased to 1 over BODY_FILL while the
// edge line eases to its faint rest), then the resting tilt + idle tumble ease in (amplitude
// ramped by `settle`), continuing seamlessly into the idle tumble once settled. `elapsed`
// accumulates only while active (the caller gates it), so at !active this ignores elapsed.
export function computeMarkFrame(elapsed: number, active: boolean): MarkFrame {
  if (!active) return { rotation: [0, 0, 0], bodyOpacity: 0, edgeOpacity: 1 };
  const fillT = easeOutQuint(clamp01((elapsed - EDGE_HOLD) / BODY_FILL));
  const settle = easeOutQuint(clamp01((elapsed - EDGE_HOLD - BODY_FILL) / TILT_SETTLE));
  return {
    rotation: [
      (BASE_TILT_X + Math.sin(elapsed * 0.21 + 1.2) * 0.09) * settle,
      Math.sin(elapsed * 0.3) * Y_SWING * settle,
      BASE_TILT_Z * settle,
    ],
    bodyOpacity: fillT,
    edgeOpacity: 1 - (1 - EDGE_REST_OPACITY) * fillT,
  };
}

type MarkPiece = {
  fill: Three.ExtrudeGeometry;
  edges: Three.EdgesGeometry;
};

// Built outside the component for clean ATS chunking + one reused build path. Exported for tests.
export function buildPieces(): MarkPiece[] {
  const data = new SVGLoader().parse(FRINK_SVG);
  const out: MarkPiece[] = [];
  for (const path of data.paths) {
    for (const shape of SVGLoader.createShapes(path)) {
      const fill = new Three.ExtrudeGeometry(shape, {
        depth: 36,
        bevelEnabled: true,
        bevelThickness: 6,
        bevelSize: 4,
        bevelSegments: 3,
      });
      // Centre the 500×500 box + half-depth on the GEOMETRY so the inner notch
      // stays locked to the panel (never .center() per shape — that desyncs it).
      fill.translate(-250, -250, -18);
      out.push({ fill, edges: new Three.EdgesGeometry(fill, EDGE_THRESHOLD) });
    }
  }
  return out;
}

function FrinkMark({ active, onReady }: { active: boolean; onReady?: () => void }) {
  const group = useRef<Three.Group>(null);
  const bodyMaterials = useRef<Three.MeshStandardMaterial[]>([]);
  const edgeMaterials = useRef<Three.LineBasicMaterial[]>([]);
  const pieces = useMemo(buildPieces, []);
  // Entrance clock — only accumulates once `active` is true, so the mark holds its mount
  // pose (front-on, edges lit, body hidden) until the swap is underway.
  const elapsed = useRef(0);
  const signalled = useRef(false);

  useEffect(() => {
    return () => {
      for (const piece of pieces) {
        piece.fill.dispose();
        piece.edges.dispose();
      }
    };
  }, [pieces]);

  useFrame((_, delta) => {
    const node = group.current;
    if (!node) return;
    // First committed frame: the GL scene is live and front-on with its edges lit, so the parent
    // can swap off the SVG trace onto a registered outline — not a misaligned tilted solid.
    if (!signalled.current) {
      signalled.current = true;
      onReady?.();
    }
    // Clock accumulates only while active, so the mark holds its mount pose until the swap begins.
    if (active) elapsed.current += delta;
    const frame = computeMarkFrame(elapsed.current, active);
    node.rotation.set(...frame.rotation);
    for (const material of bodyMaterials.current) material.opacity = frame.bodyOpacity;
    for (const material of edgeMaterials.current) material.opacity = frame.edgeOpacity;
  });

  return (
    <group ref={group} rotation={[0, 0, 0]}>
      {/* SVG is y-down; -Y flips to three's y-up. 0.012 fits the 500-unit box. */}
      <group scale={[0.012, -0.012, 0.012]}>
        {pieces.map((piece, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: piece list is stable
          <group key={index}>
            {/* Polished solid body — opacity is driven 0→1 by the entrance so the outline
                fills into a solid. transparent + depthWrite stay on so the fading body still
                occludes correctly (no see-through ghosting of the back faces). */}
            <mesh geometry={piece.fill}>
              <meshStandardMaterial
                ref={(material) => {
                  if (material) bodyMaterials.current[index] = material;
                }}
                color={MARK_COLOR}
                metalness={0.4}
                roughness={0.3}
                envMapIntensity={0.9}
                transparent
                depthWrite
                opacity={0}
              />
            </mesh>
            {/* The entering outline: the same violet line the SVG trace drew, now as the
                extruded edges. Full at entry, eased to a faint depth-TESTED crisp once filled
                — no additive blend (it inverts on the white theme), no glow. */}
            <lineSegments geometry={piece.edges}>
              <lineBasicMaterial
                ref={(material) => {
                  if (material) edgeMaterials.current[index] = material;
                }}
                color={EDGE_COLOR}
                transparent
                opacity={1}
              />
            </lineSegments>
          </group>
        ))}
      </group>
    </group>
  );
}

export function FrinkScene({
  className,
  active,
  onReady,
}: {
  className?: string;
  active: boolean;
  onReady?: () => void;
}) {
  return (
    <Canvas
      aria-hidden
      className={className}
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true }}
      camera={{ fov: 40, position: [0, 0, 9] }}
    >
      {/* Studio lighting does the work: soft ambient fill, a warm-white key raking
          the bevels from upper-right, a cool violet fill from the left for form, and
          a violet rim from behind to glow the edges — a product render, not an icon. */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 6, 7]} intensity={1.45} color="#fff4e8" />
      <directionalLight position={[-6, -1, 5]} intensity={0.45} color="#bcaaff" />
      <pointLight position={[-4, 3, -6]} intensity={1.8} color="#8b6cff" distance={26} />
      <FrinkMark active={active} onReady={onReady} />
    </Canvas>
  );
}
