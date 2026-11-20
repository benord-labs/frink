// Resolves imports for go to definition with TypeScript's own parser and module resolution, using the
// compiler options of the config that owns each file, with a filesystem fallback for non-TS assets.

import { dirname, isAbsolute, join } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import {
  buildSourceOverlay,
  type DefinitionLocation,
  findImportBindingAt,
  locateExport,
} from './definition-locator';
import { clearTsconfigOwnerCache, findOwningCompilerOptions, isWithin } from './tsconfig-owner';

const TS_PATHS_TRAILING_GLOB = /\*$/;

export type ResolveDefinitionInput = {
  projectPath: string;
  containingFile: string;
  /** Live buffer of `containingFile`; with `offset`, finds the import under the cursor. */
  fileContent?: string;
  offset?: number;
  /** A quoted module specifier the user clicked. */
  specifier?: string;
  /** Unsaved text of other open files by absolute path, read instead of the file on disk; `null`
   * for one too large to send. */
  openBuffers?: Record<string, string | null>;
};

function fileStart(path: string): DefinitionLocation {
  return { path, line: 1, column: 1, endColumn: 1 };
}

/** Where the clicked import or specifier is defined: the exact declaration when it can be found in
 * the target, otherwise the top of the target file. Null when nothing resolves. */
export function resolveDefinition(input: ResolveDefinitionInput): DefinitionLocation | null {
  const { projectPath, containingFile, fileContent, offset, specifier, openBuffers } = input;
  if (specifier) {
    const path = resolveModuleSpecifier(projectPath, containingFile, specifier);
    return path ? fileStart(path) : null;
  }
  if (fileContent === undefined || offset === undefined) return null;

  const binding = findImportBindingAt(fileContent, containingFile, offset);
  if (!binding) return null;
  const target = resolveModuleSpecifier(projectPath, containingFile, binding.specifier);
  if (!target) return null;
  if (binding.importedName === '*') return fileStart(target);

  const clickedOptions = findOwningCompilerOptions(projectPath, containingFile).options;
  const resolveFrom = (fromFile: string, next: string): string | null => {
    if (isAbsolute(next)) return null;
    return isWithin(projectPath, fromFile)
      ? resolveInProject(projectPath, fromFile, next)
      : resolveWithOptions(clickedOptions, fromFile, next);
  };
  const overlay = buildSourceOverlay({ ...openBuffers, [containingFile]: fileContent });
  return locateExport(target, binding.importedName, resolveFrom, overlay) ?? fileStart(target);
}

/** Resolves a specifier with the owning tsconfig, falling back to probing for non-TS assets. */
export function resolveModuleSpecifier(
  projectPath: string,
  containingFile: string,
  specifier: string,
): string | null {
  // Reject absolute specifiers to keep resolution within project scope
  if (specifier.startsWith('/') || isAbsolute(specifier)) {
    return null;
  }
  return resolveInProject(projectPath, containingFile, specifier);
}

function resolveInProject(projectPath: string, containingFile: string, specifier: string) {
  const { options, pathsFallback } = findOwningCompilerOptions(projectPath, containingFile);
  const resolved = resolveWithOptions(options, containingFile, specifier);
  if (resolved || !pathsFallback) return resolved;
  return resolveWithOptions(pathsFallback, containingFile, specifier);
}

function resolveWithOptions(
  options: ts.CompilerOptions,
  containingFile: string,
  specifier: string,
): string | null {
  const tsResult = ts.resolveModuleName(specifier, containingFile, options, ts.sys);
  if (tsResult.resolvedModule?.resolvedFileName) {
    return tsResult.resolvedModule.resolvedFileName;
  }

  const aliasResult = resolveViaAliasSubstitution(options, specifier);
  if (aliasResult) return aliasResult;

  if (specifier.startsWith('.')) {
    return resolveRelativeAsset(containingFile, specifier);
  }

  return null;
}

/** The first existing file among `resolved`, `resolved` plus an asset extension, or an index file in it. */
function probeAsset(resolved: string): string | null {
  const candidates = [
    resolved,
    ...ASSET_EXTENSIONS.map((ext) => `${resolved}${ext}`),
    ...INDEX_CANDIDATES.map((idx) => join(resolved, idx)),
  ];
  return candidates.find((candidate) => ts.sys.fileExists(candidate)) ?? null;
}

/** Relative imports of non-TS assets, which ts.resolveModuleName does not resolve. */
function resolveRelativeAsset(containingFile: string, specifier: string): string | null {
  return probeAsset(join(dirname(containingFile), specifier));
}

/** `paths` alias substitution for non-TS assets, which ts.resolveModuleName does not resolve. */
function resolveViaAliasSubstitution(
  options: ts.CompilerOptions,
  specifier: string,
): string | null {
  const base = z.string().safeParse(options.baseUrl ?? options.pathsBasePath);
  if (!options.paths || !base.success) return null;

  for (const [pattern, targets] of Object.entries(options.paths)) {
    const prefix = pattern.replace(TS_PATHS_TRAILING_GLOB, '');
    const matches = prefix === pattern ? specifier === pattern : specifier.startsWith(prefix);
    if (!matches) continue;
    const remainder = specifier.slice(prefix.length);
    const found = firstAsset(targets, (target) =>
      join(base.data, target.replace(TS_PATHS_TRAILING_GLOB, ''), remainder),
    );
    if (found) return found;
  }
  return null;
}

function firstAsset(targets: readonly string[], toPath: (target: string) => string) {
  for (const target of targets) {
    const found = probeAsset(toPath(target));
    if (found) return found;
  }
  return null;
}

const ASSET_EXTENSIONS = [
  '.scss',
  '.css',
  '.less',
  '.sass',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.module.scss',
  '.module.css',
] as const;

const INDEX_CANDIDATES = [
  'index.scss',
  'index.css',
  'index.less',
  '_index.scss',
  '_index.sass',
] as const;

export function clearResolverCache(): void {
  clearTsconfigOwnerCache();
}
