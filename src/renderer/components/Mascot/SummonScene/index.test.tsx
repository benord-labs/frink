// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VoxelFallbackBoundary } from './index';

function BrokenScene(): never {
  throw new Error('WebGL context lost');
}

describe('VoxelFallbackBoundary', () => {
  it('shows the fallback Frink when the 3D scene throws, instead of ending the summon', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByText } = render(
      <VoxelFallbackBoundary fallback={<p>pixel frink</p>}>
        <BrokenScene />
      </VoxelFallbackBoundary>,
    );
    expect(getByText('pixel frink')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('renders the 3D scene when nothing goes wrong', () => {
    const { getByText } = render(
      <VoxelFallbackBoundary fallback={<p>pixel frink</p>}>
        <p>voxel frink</p>
      </VoxelFallbackBoundary>,
    );
    expect(getByText('voxel frink')).toBeTruthy();
  });
});
