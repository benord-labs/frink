// Picks the tsconfig/jsconfig that owns a file, including solution-style roots and monorepo packages.
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { CONFIG_CANDIDATES } from './constants';

type ParsedConfig = {
  configPath: string;
  options: ts.CompilerOptions;
  fileSet: Set<string>;
  referencePaths: string[];
  watchedFiles: readonly string[];
  stamp: string;
};

export type OwningCompilerOptions = {
  options: ts.CompilerOptions;
  configPath: string | null;
  /** Nearest config with `paths` when the owner has none, e.g. a solution root holding them. */
  pathsFallback: ts.CompilerOptions | null;
};

const MAX_REFERENCE_DEPTH = 3;

const parsedCache = new Map<string, ParsedConfig>();

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function stampOf(paths: readonly string[]): string {
  return paths.map((path) => `${path}:${mtimeOf(path)}`).join('|');
}

/** TypeScript lists files with `/` separators, and compares them case-insensitively where the
 * file system is; config paths here are built from the clicked file's own path, so no realpath. */
function fileKey(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return ts.sys.useCaseSensitiveFileNames ? slashed : slashed.toLowerCase();
}

function parseConfig(configPath: string): ParsedConfig | null {
  const cached = parsedCache.get(configPath);
  if (cached && cached.stamp === stampOf(cached.watchedFiles)) return cached;
  if (!ts.sys.fileExists(configPath)) {
    parsedCache.delete(configPath);
    return null;
  }

  const configStamp = stampOf([configPath]);
  const sourceFile = ts.readJsonConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonSourceFileConfigFileContent(
    sourceFile,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  const extended = sourceFile.extendedSourceFiles ?? [];
  const watchedFiles = [configPath, ...extended];
  const result: ParsedConfig = {
    configPath,
    options: parsed.options,
    fileSet: new Set(parsed.fileNames.map(fileKey)),
    referencePaths: (parsed.projectReferences ?? []).map((ref) =>
      ts.resolveProjectReferencePath(ref),
    ),
    watchedFiles,
    // Stamped before the read, so an edit landing mid-parse invalidates on the next lookup.
    stamp: [configStamp, ...extended.map((path) => stampOf([path]))].join('|'),
  };
  parsedCache.set(configPath, result);
  return result;
}

function referencedConfigs(config: ParsedConfig): ParsedConfig[] {
  return config.referencePaths.flatMap((path) => parseConfig(path) ?? []);
}

/** References are checked before the config itself: a solution root lists no files of its own. */
function findIncludingConfig(
  config: ParsedConfig,
  file: string,
  visited: Set<string>,
  depth: number,
): ParsedConfig | null {
  if (visited.has(config.configPath)) return null;
  visited.add(config.configPath);
  if (depth < MAX_REFERENCE_DEPTH) {
    for (const referenced of referencedConfigs(config)) {
      const owner = findIncludingConfig(referenced, file, visited, depth + 1);
      if (owner) return owner;
    }
  }
  return config.fileSet.has(file) ? config : null;
}

function collectWithReferences(config: ParsedConfig, out: ParsedConfig[], depth = 0): void {
  if (out.includes(config)) return;
  out.push(config);
  if (depth >= MAX_REFERENCE_DEPTH) return;
  for (const referenced of referencedConfigs(config)) {
    collectWithReferences(referenced, out, depth + 1);
  }
}

function* configsInDirectory(dir: string): Generator<ParsedConfig> {
  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = join(dir, candidate);
    const parsed = parseConfig(configPath);
    if (parsed) yield parsed;
  }
}

export function isWithin(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function* configsUpTo(projectPath: string, containingFile: string): Generator<ParsedConfig> {
  let dir = dirname(containingFile);
  while (isWithin(projectPath, dir)) {
    yield* configsInDirectory(dir);
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function nearestConfigWithPaths(projectPath: string, containingFile: string): ParsedConfig | null {
  const seen: ParsedConfig[] = [];
  for (const config of configsUpTo(projectPath, containingFile)) {
    collectWithReferences(config, seen);
    const withPaths = seen.find((candidate) => candidate.options.paths);
    if (withPaths) return withPaths;
  }
  return null;
}

function result(config: ParsedConfig, projectPath: string, file: string): OwningCompilerOptions {
  const pathsFallback = config.options.paths ? null : nearestConfigWithPaths(projectPath, file);
  return {
    options: config.options,
    configPath: config.configPath,
    pathsFallback: pathsFallback?.options ?? null,
  };
}

/**
 * Walks up to `projectPath` for the nearest config (or referenced config) that includes the file.
 * When none does, the first config with `paths` wins, then the nearest config.
 */
export function findOwningCompilerOptions(
  projectPath: string,
  containingFile: string,
): OwningCompilerOptions {
  const file = fileKey(containingFile);
  const seen: ParsedConfig[] = [];
  for (const config of configsUpTo(projectPath, containingFile)) {
    const owner = findIncludingConfig(config, file, new Set(), 0);
    if (owner) return result(owner, projectPath, containingFile);
    collectWithReferences(config, seen);
  }
  const fallback = seen.find((config) => config.options.paths) ?? seen[0];
  return fallback
    ? result(fallback, projectPath, containingFile)
    : { options: {}, configPath: null, pathsFallback: null };
}

export function clearTsconfigOwnerCache(): void {
  parsedCache.clear();
}
