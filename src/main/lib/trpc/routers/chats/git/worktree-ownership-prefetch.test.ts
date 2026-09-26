import { expect, it } from 'vitest';
import { findUnmanagedWorktrees } from './worktree-ownership-prefetch';

it('bounds simultaneous reads and retains only negative ownership evidence', async () => {
  let active = 0;
  let peak = 0;
  const paths = Array.from({ length: 23 }, (_, i) => String(i));
  const result = await findUnmanagedWorktrees(paths, async (path) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return path === '1';
  });
  expect(peak).toBe(8);
  expect(active).toBe(0);
  expect(result).toEqual(new Set(paths.filter((path) => path !== '1')));
});
