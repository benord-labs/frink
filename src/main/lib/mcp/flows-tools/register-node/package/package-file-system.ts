import type { Mode, PathLike } from 'node:fs';
import * as fsPromises from 'node:fs/promises';

export type PackageFileHandle = Awaited<ReturnType<typeof fsPromises.open>>;

/** Narrow runtime seam for descriptor-open race tests. */
export const packageFileSystem = {
  open(path: PathLike, flags: string | number, mode?: Mode): Promise<PackageFileHandle> {
    return fsPromises.open(path, flags, mode);
  },
};
