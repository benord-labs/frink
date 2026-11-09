import { z } from 'zod';
import { publicProcedure } from '../index';

type ListedEntry = { path: string; type: 'file' | 'folder' };

// One index per cached listing: every file path, written with `/`, under its name.
const indexByListing = new WeakMap<readonly ListedEntry[], Map<string, string[]>>();

function filesByName(entries: readonly ListedEntry[]): Map<string, string[]> {
  const cached = indexByListing.get(entries);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const file = entry.path.replaceAll('\\', '/');
    const name = file.slice(file.lastIndexOf('/') + 1);
    const paths = index.get(name);
    if (paths) paths.push(file);
    else index.set(name, [file]);
  }
  indexByListing.set(entries, index);
  return index;
}

/** The one project file each bare name stands for, or null when none or several match. */
export function resolveFileNames(
  entries: readonly ListedEntry[],
  names: readonly string[],
): Record<string, string | null> {
  const index = filesByName(entries);
  return Object.fromEntries(
    names.map((name) => {
      const paths = index.get(name);
      return [name, paths?.length === 1 ? paths[0] : null];
    }),
  );
}

/** files.resolveNames: the one project file each bare file name in an agent reply stands for. */
export function resolveNamesProcedure(
  listEntries: (projectPath: string) => Promise<readonly ListedEntry[]>,
) {
  return publicProcedure
    .input(z.object({ projectPath: z.string().min(1), names: z.array(z.string()).max(200) }))
    .query(async ({ input }) =>
      resolveFileNames(await listEntries(input.projectPath), input.names),
    );
}
