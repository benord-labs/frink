import { type ReactNode, Suspense, useState } from 'react';
import { FRINK_BOX, FRINK_CANVAS, type FrinkPose } from '@/lib/mascot/voxel-frink-model';
import { hasWebGl } from '@/lib/webgl/has-webgl';
import { VoxelFallbackBoundary, VoxelFrink } from '../SummonScene';

type MascotFigureProps = {
  pose: FrinkPose;
  /** Frink's height in CSS px. */
  height: number;
  /** The pixel sprite, shown without WebGL or when the 3D scene fails. */
  sprite: ReactNode;
};

/** The voxel Frink at a given height for the walk-by easter eggs, else their pixel sprite. */
export function MascotFigure({ pose, height, sprite }: MascotFigureProps) {
  const [webgl] = useState(hasWebGl);
  if (!webgl) return sprite;
  const scale = height / FRINK_BOX.height;
  return (
    <div className="relative" style={{ width: FRINK_BOX.width * scale, height }}>
      <VoxelFallbackBoundary fallback={sprite}>
        <div
          className="absolute"
          style={{
            left: ((FRINK_BOX.width - FRINK_CANVAS.width) / 2) * scale,
            top: ((FRINK_BOX.height - FRINK_CANVAS.height) / 2) * scale,
          }}
        >
          <Suspense fallback={null}>
            <VoxelFrink pose={pose} build="assemble" scale={scale} />
          </Suspense>
        </div>
      </VoxelFallbackBoundary>
    </div>
  );
}
