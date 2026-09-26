import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { entrypointError } from '../package-registration';
import { registerNodeDependencies } from '../register-node-dependencies';
import type { RegisterNodeInput } from '../register-node-support';
import { defaultNodesRoot } from './lifecycle';

const INLINE_PACKAGE_DIR = 'inline';

/**
 * Where the package pipeline captures source from: `packagePath` relative to
 * `projectRoot`. `displayPath` is what the permission preview shows — absent
 * for inline registrations, which have no user-visible folder.
 */
export type ResolvedRegistrationSource =
  | { ok: true; packagePath: string; projectRoot: string; displayPath?: string }
  | { ok: false; error: string };

/** Synthesize an inline registration into a Frink-owned staging folder, or map a user folder path onto the package pipeline's (projectRoot, relative path) contract. */
export async function resolveRegistrationSource(
  input: RegisterNodeInput,
  sessionRoot: string,
  sessionProjectPath: string | undefined,
): Promise<ResolvedRegistrationSource> {
  if (input.source === 'inline') {
    const entrypointIssue = entrypointError(input.manifest.entrypoint);
    if (entrypointIssue) return { ok: false, error: entrypointIssue };
    const inlineDir = join(sessionRoot, INLINE_PACKAGE_DIR);
    await registerNodeDependencies.mkdir(inlineDir);
    await registerNodeDependencies.writeFile(
      join(inlineDir, 'manifest.json'),
      JSON.stringify(input.manifest, null, 2),
      'utf8',
    );
    await registerNodeDependencies.writeFile(
      join(inlineDir, input.manifest.entrypoint),
      input.scriptContent,
      'utf8',
    );
    return { ok: true, packagePath: INLINE_PACKAGE_DIR, projectRoot: sessionRoot };
  }
  if (input.packagePath.startsWith('~')) {
    return {
      ok: false,
      error:
        'Use a full path starting with / (or a path relative to this project) — ~ is not expanded here.',
    };
  }
  if (isAbsolute(input.packagePath)) {
    const resolved = resolve(input.packagePath);
    if (dirname(resolved) === resolved) {
      return { ok: false, error: 'packagePath must name a package folder, not a filesystem root.' };
    }
    const nodesRoot = defaultNodesRoot();
    if (resolved === nodesRoot || resolved.startsWith(nodesRoot + sep)) {
      return {
        ok: false,
        error:
          'That folder is where Frink keeps installed nodes, not where you author them. Edit your source folder and register that, or pass manifest + scriptContent for a single-file node.',
      };
    }
    return {
      ok: true,
      packagePath: basename(resolved),
      projectRoot: dirname(resolved),
      displayPath: input.packagePath,
    };
  }
  const hasProject =
    sessionProjectPath !== undefined &&
    resolve(sessionProjectPath) !== registerNodeDependencies.homedir();
  if (!hasProject) {
    return {
      ok: false,
      error:
        'This chat has no project, so a relative packagePath has no root. Pass manifest + scriptContent for a single-file node, or an absolute folder path.',
    };
  }
  return {
    ok: true,
    packagePath: input.packagePath,
    projectRoot: sessionProjectPath,
    displayPath: input.packagePath,
  };
}
