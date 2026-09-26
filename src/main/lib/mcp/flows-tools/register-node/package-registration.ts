import { extname } from 'node:path';
import {
  CUSTOM_NODE_ENTRYPOINT_EXTENSION,
  isCustomNodeEntrypoint,
} from '../../../custom-nodes/runtime';
import { readPackageManifest } from './package';
import {
  type RegisterNodeManifest,
  registerNodeManifestSchema,
  validateJavaScriptSource,
} from './register-node-support';
import {
  type PackageSnapshot,
  PackageValidationError,
  stagePackageDirectory,
} from './resource-files';

type StageRegistrationPackageInput = {
  packagePath: string;
  projectRoot: string;
  stagingRoot: string;
};

type StageRegistrationPackageResult =
  | { ok: true; manifest: RegisterNodeManifest; snapshot: PackageSnapshot }
  | { ok: false; error: string };
type StagePackageDirectory = typeof stagePackageDirectory;

const ENTRYPOINT_SEPARATOR_RE = /[\\/]/;

export function entrypointError(entrypoint: string): string | null {
  if (entrypoint.trim() !== entrypoint) {
    return 'entrypoint must not contain leading or trailing whitespace';
  }
  if (ENTRYPOINT_SEPARATOR_RE.test(entrypoint)) {
    return 'entrypoint must be a plain filename with no separators';
  }
  if (isCustomNodeEntrypoint(entrypoint)) return null;
  return `entrypoint extension "${extname(entrypoint).toLowerCase()}" is not supported. Expected: ${CUSTOM_NODE_ENTRYPOINT_EXTENSION}`;
}

export async function stageRegistrationPackage(
  input: StageRegistrationPackageInput,
  stagePackage: StagePackageDirectory = stagePackageDirectory,
): Promise<StageRegistrationPackageResult> {
  try {
    const sourceManifest = await readPackageManifest(input);
    const parsedManifest = registerNodeManifestSchema.safeParse(sourceManifest.value);
    if (!parsedManifest.success) {
      const issues = parsedManifest.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return {
        ok: false,
        error: `Package manifest.json does not match the register-node manifest schema: ${issues}`,
      };
    }
    const manifest = parsedManifest.data;
    const entrypointIssue = entrypointError(manifest.entrypoint);
    if (entrypointIssue) return { ok: false, error: entrypointIssue };

    const snapshot = await stagePackage({
      entrypoint: manifest.entrypoint,
      packagePath: input.packagePath,
      projectRoot: input.projectRoot,
      stagingRoot: input.stagingRoot,
    });
    if (!snapshot.manifestBytes.equals(sourceManifest.bytes)) {
      return {
        ok: false,
        error: 'Package manifest.json changed while being snapshotted',
      };
    }
    const sourceError = validateJavaScriptSource(
      snapshot.entrypointBytes.toString('utf8'),
      manifest.entrypoint,
    );
    if (sourceError) return { ok: false, error: sourceError };
    for (const module of snapshot.modules) {
      const moduleError = validateJavaScriptSource(module.source, module.path);
      if (moduleError) return { ok: false, error: moduleError };
    }
    return { ok: true, manifest, snapshot };
  } catch (error) {
    if (error instanceof PackageValidationError) {
      return {
        ok: false,
        error: `Package validation failed: ${error.message}`,
      };
    }
    throw error;
  }
}
