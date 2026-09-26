import { dirname, join } from 'node:path';
import ts from 'typescript';
import { CONFIG_CANDIDATES } from './tsconfig-candidates';

/**
 * Parsed `compilerOptions.baseUrl` and `compilerOptions.paths` from `tsconfig.json` (or extended configs),
 * used to resolve TypeScript path aliases the same way the compiler does.
 *
 * Exported so declaration emit can name `resolveTsConfigPaths` return types (tRPC / inferred client types).
 *
 * @see https://www.typescriptlang.org/tsconfig#baseUrl
 * @see https://www.typescriptlang.org/tsconfig#paths
 */
export type TsConfigPaths = {
  /** Optional root for non-relative imports; path mappings are resolved relative to this directory when set. */
  baseUrl?: string;
  /**
   * Optional path rewrites: each key is a module pattern (e.g. `"@/*"`), each value is one or more
   * replacement path patterns (e.g. `["./src/*"]`), mirroring `compilerOptions.paths`.
   */
  paths?: Record<string, string[]>;
};

function hasPathAliases(options: ts.CompilerOptions): boolean {
  return typeof options.baseUrl === 'string' || Boolean(options.paths);
}

/**
 * Resolves path alias options using TypeScript's official config parser.
 * This handles comments, trailing commas, `$schema` URLs, and `extends`.
 */
export async function resolveTsConfigPaths(projectPath: string): Promise<TsConfigPaths> {
  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = join(projectPath, candidate);
    if (!ts.sys.fileExists(configPath)) continue;

    const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (readResult.error) continue;

    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );

    if (!hasPathAliases(parsed.options)) continue;

    return {
      baseUrl:
        typeof parsed.options.baseUrl === 'string'
          ? parsed.options.baseUrl
          : parsed.options.paths
            ? dirname(configPath)
            : undefined,
      paths: parsed.options.paths,
    };
  }

  return {};
}
