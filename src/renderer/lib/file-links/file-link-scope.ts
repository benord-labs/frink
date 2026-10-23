import { createContext } from 'react';
import { isBareFileName } from './file-link-target';

// Adapted from T3 Code's fileLinks.ts (MIT).

/** What one agent reply knows about its file references, beyond what each block can see alone. */
export type FileLinkLabels = {
  /** The project file a bare name stands for, when exactly one file has that name. */
  resolve: (name: string) => string | undefined;
  /** The parent folders that tell a file from another file of the same name in the reply. */
  suffixFor: (file: string) => string | undefined;
};

/** A reply's labels, and how each reference the reply renders joins them. */
export type FileLinkScope = FileLinkLabels & {
  /** Adds a reference as its badge mounts; the returned function takes it away again. */
  register: (file: string) => () => void;
};

/** The file-link scope of the agent reply around a badge; null outside one, where bare names stay code. */
export const FileLinkScopeContext = createContext<FileLinkScope | null>(null);

/** A reference as the reply's files compare: `/` separators, no `./`, and relative to the chat's folder. */
export function scopePath(file: string, root: string | undefined): string {
  const normal = file.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  const base = root?.replaceAll('\\', '/').replace(/\/+$/, '');
  return base && normal.startsWith(`${base}/`) ? normal.slice(base.length + 1) : normal;
}

function parentSegments(file: string): string[] {
  return file.split('/').filter(Boolean).slice(0, -1);
}

function trailing(segments: string[], depth: number): string {
  return segments.slice(-depth).join('/');
}

// The fewest trailing parent folders no other file in the group shares, or all of them.
function uniqueParentDepth(segments: string[], others: string[][]): number {
  const collides = (depth: number) =>
    others.some((other) => trailing(other, depth) === trailing(segments, depth));
  let depth = 1;
  while (depth < segments.length && collides(depth)) depth += 1;
  return depth;
}

function groupByName(files: readonly string[]): Set<string>[] {
  const groups = new Map<string, Set<string>>();
  for (const file of files) {
    const name = file.split('/').findLast(Boolean);
    if (name) groups.set(name, (groups.get(name) ?? new Set()).add(file));
  }
  return [...groups.values()];
}

/** For each file sharing its name with another, the fewest parent folders (at least two) that set it apart. */
export function buildFileLinkSuffixByPath(files: readonly string[]): Map<string, string> {
  const suffixByPath = new Map<string, string>();
  for (const group of groupByName(files).filter((paths) => paths.size > 1)) {
    const parents = [...group].map((file) => ({ file, segments: parentSegments(file) }));
    for (const { file, segments } of parents) {
      if (segments.length === 0) continue;
      const others = parents.filter((other) => other.file !== file).map((other) => other.segments);
      const depth = Math.max(uniqueParentDepth(segments, others), 2);
      suffixByPath.set(file, trailing(segments, Math.min(segments.length, depth)));
    }
  }
  return suffixByPath;
}

/** The labels of one reply's rendered references: bare names placed by the lookup, same-name files told apart. */
export function buildFileLinkLabels(
  references: readonly string[],
  resolved: Readonly<Record<string, string | null>> | undefined,
  root: string | undefined,
): FileLinkLabels {
  const resolve = (name: string) => resolved?.[name] ?? undefined;
  const files = references.flatMap((file) =>
    isBareFileName(file) ? (resolve(file) ?? []) : [scopePath(file, root)],
  );
  const suffixByPath = buildFileLinkSuffixByPath(files);
  return { resolve, suffixFor: (file) => suffixByPath.get(scopePath(file, root)) };
}
