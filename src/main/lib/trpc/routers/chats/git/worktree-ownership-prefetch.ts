import { captureContained } from '../../../../sentry';

const OWNERSHIP_READ_CONCURRENCY = 8;

/** Cache only negative ownership evidence. Positive results must be rechecked before deletion. */
export async function findUnmanagedWorktrees(
  paths: string[],
  readOwnership: (path: string) => Promise<boolean>,
): Promise<Set<string>> {
  const unmanaged = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += OWNERSHIP_READ_CONCURRENCY) {
    await Promise.all(
      paths.slice(offset, offset + OWNERSHIP_READ_CONCURRENCY).map(async (path) => {
        const managed = await readOwnership(path).catch((error) => {
          captureContained(error, { surface: 'worktree-ownership', stage: 'startup-prefetch' });
          return false;
        });
        if (!managed) unmanaged.add(path);
      }),
    );
  }
  return unmanaged;
}
