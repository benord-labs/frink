import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useState } from 'react';
import { FRINK_CANVAS, type FrinkBuild, type FrinkPose } from '@/lib/mascot/voxel-frink-model';
import { createVoxelFrinkRig, FRINK_CAMERA } from '@/lib/mascot/voxel-frink-rig';

type Point = { x: number; y: number };

type VoxelFrinkProps = {
  pose: FrinkPose;
  build: FrinkBuild;
  /** Receives the chalk tip every frame, in px from the top-left of FRINK_BOX. */
  tipRef?: RefObject<Point | null>;
  /** Draws Frink this many times his FRINK_BOX size. */
  scale?: number;
};

function FrinkModel({ pose, build, tipRef }: Omit<VoxelFrinkProps, 'scale'>) {
  const [rig] = useState(createVoxelFrinkRig);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    camera.lookAt(...FRINK_CAMERA.lookAt);
  }, [camera]);
  useEffect(() => () => rig.dispose(), [rig]);
  useEffect(() => rig.setPose(pose), [rig, pose]);
  useEffect(() => rig.setBuild(build), [rig, build]);

  useFrame((_state, delta) => {
    const tip = rig.update(performance.now(), Math.min(delta, 0.05), camera);
    if (tipRef) tipRef.current = tip;
  });

  return <primitive object={rig.object} />;
}

/** The 3D voxel Frink. Lazy-loaded behind a WebGL probe so three.js stays out of the main chunk. */
export function VoxelFrink({ scale = 1, ...props }: VoxelFrinkProps) {
  return (
    <Canvas
      flat
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true }}
      camera={{
        fov: FRINK_CAMERA.fov,
        near: FRINK_CAMERA.near,
        far: FRINK_CAMERA.far,
        position: FRINK_CAMERA.position,
      }}
      style={{
        width: FRINK_CANVAS.width * scale,
        height: FRINK_CANVAS.height * scale,
        pointerEvents: 'none',
      }}
    >
      <FrinkModel {...props} />
    </Canvas>
  );
}
