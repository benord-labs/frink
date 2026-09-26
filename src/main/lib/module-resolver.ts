/**
 * Universal module resolver using TypeScript's own APIs.
 *
 * Provides two capabilities:
 * 1. findModuleSpecifierForSymbol — uses TS parser to find which module
 *    a symbol is imported from (handles all import syntaxes).
 * 2. resolveModuleSpecifier — uses ts.resolveModuleName with the project's
 *    tsconfig.json to resolve any module specifier to an absolute file path.
 *
 * This replaces manual regex/extension-list hacks with TypeScript's own
 * parser and module resolution — the same engine VS Code uses internally.
 */

import { dirname, isAbsolute, join } from 'node:path';
import ts from 'typescript';
import { CONFIG_CANDIDATES } from './tsconfig-candidates';

type ResolvedCompilerOptions = {
  options: ts.CompilerOptions;
  projectDir: string;
};

const configCache = new Map<string, ResolvedCompilerOptions>();

const TS_PATHS_TRAILING_GLOB = /\*$/;

function loadCompilerOptions(projectPath: string): ResolvedCompilerOptions {
  const cached = configCache.get(projectPath);
  if (cached) return cached;

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = join(projectPath, candidate);
    if (!ts.sys.fileExists(configPath)) continue;

    const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (readResult.error) continue;

    const projectDir = dirname(configPath);
    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      projectDir,
      undefined,
      configPath,
    );

    const result = { options: parsed.options, projectDir };
    configCache.set(projectPath, result);
    return result;
  }

  const fallback = { options: {} as ts.CompilerOptions, projectDir: projectPath };
  configCache.set(projectPath, fallback);
  return fallback;
}

/**
 * Use TypeScript's parser to find which module a symbol is imported from.
 * Handles: named imports, default imports, namespace imports, re-exports.
 */
export function findModuleSpecifierForSymbol(
  fileContent: string,
  symbolName: string,
  fileName = 'temp.ts',
): string | null {
  const sourceFile = ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest, true);

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) continue;

      if (clause.name?.text === symbolName) return specifier;

      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (el.name.text === symbolName) return specifier;
          }
        }
        if (ts.isNamespaceImport(clause.namedBindings)) {
          if (clause.namedBindings.name.text === symbolName) return specifier;
        }
      }
    }

    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const specifier = stmt.moduleSpecifier.text;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text === symbolName) return specifier;
        }
      }
    }
  }

  return null;
}

/**
 * Use TypeScript's module resolution to resolve a specifier to a file path.
 * Supports all tsconfig options: paths, baseUrl, moduleResolution, etc.
 * Falls back to alias substitution + filesystem probing for non-TS files
 * (e.g. .scss, .css, .json, .svg).
 */
export function resolveModuleSpecifier(
  projectPath: string,
  containingFile: string,
  specifier: string,
): string | null {
  // Reject absolute specifiers to keep resolution within project scope
  if (specifier.startsWith('/') || isAbsolute(specifier)) {
    return null;
  }
  const { options } = loadCompilerOptions(projectPath);

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

/**
 * Resolve relative imports for non-TS assets (.scss, .css, .json, etc.)
 * that ts.resolveModuleName doesn't handle.
 * Only called with relative specifiers (`./` or `../`); absolute paths are rejected earlier in
 * {@link resolveModuleSpecifier}.
 */
function resolveRelativeAsset(containingFile: string, specifier: string): string | null {
  const dir = dirname(containingFile);
  const resolved = join(dir, specifier);

  if (ts.sys.fileExists(resolved)) return resolved;

  for (const ext of ASSET_EXTENSIONS) {
    const withExt = `${resolved}${ext}`;
    if (ts.sys.fileExists(withExt)) return withExt;
  }

  for (const idx of INDEX_CANDIDATES) {
    const withIndex = join(resolved, idx);
    if (ts.sys.fileExists(withIndex)) return withIndex;
  }

  return null;
}

/**
 * Simple alias substitution + filesystem probing.
 * Handles any file type that ts.resolveModuleName ignores (.scss, .css, etc.).
 */
function resolveViaAliasSubstitution(
  options: ts.CompilerOptions,
  specifier: string,
): string | null {
  const { paths, baseUrl } = options;
  if (!paths || !baseUrl) return null;

  for (const [pattern, targets] of Object.entries(paths)) {
    const prefix = pattern.replace(TS_PATHS_TRAILING_GLOB, '');
    if (!specifier.startsWith(prefix)) continue;
    const remainder = specifier.slice(prefix.length);

    for (const target of targets) {
      const base = target.replace(TS_PATHS_TRAILING_GLOB, '');
      const resolved = join(baseUrl, base, remainder);

      if (ts.sys.fileExists(resolved)) return resolved;

      for (const ext of ASSET_EXTENSIONS) {
        const withExt = `${resolved}${ext}`;
        if (ts.sys.fileExists(withExt)) return withExt;
      }

      for (const idx of INDEX_CANDIDATES) {
        const withIndex = join(resolved, idx);
        if (ts.sys.fileExists(withIndex)) return withIndex;
      }
    }
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
  configCache.clear();
}
