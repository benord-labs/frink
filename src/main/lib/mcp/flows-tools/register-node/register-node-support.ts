import { parse } from 'acorn';
import { z } from 'zod';
import { isReservedNodeName } from '../../../../../shared/integrations/plugin-nodes';
import type { JsonValue } from '../../../../../shared/types/permissions';
import {
  parseCustomNodeEntrypointSpec,
  resolveContainedCustomNodePath,
} from '../../../custom-nodes/runtime';
import { readBoundedInstalledFile } from './package';
import { MAX_PACKAGE_METADATA_BYTES } from './resource-files';

const RESERVED_NAME_MESSAGE =
  'name is reserved: "integrations" is the folder Frink generates plugin nodes into, and "<pluginId>_" prefixes belong to that plugin';

const manifestOutputFieldSchema: z.ZodType<Record<string, JsonValue>> = z.record(
  z.string(),
  z.json(),
);

export const registerNodeManifestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'name must match /^[a-z0-9][a-z0-9_-]*$/')
      .refine((name) => !isReservedNodeName(name), RESERVED_NAME_MESSAGE),
    displayName: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    entrypoint: z.string().min(1),
    timeout: z.number().int().positive().max(600).optional(),
    inputs: z.record(z.string(), z.json()).optional(),
    credentials: z.record(z.string(), z.json()).optional(),
    outputs: manifestOutputFieldSchema.optional(),
  })
  .strict();

export type RegisterNodeManifest = z.infer<typeof registerNodeManifestSchema>;

export const registerNodeArgsSchema = z
  .object({
    manifest: registerNodeManifestSchema.optional(),
    scriptContent: z
      .string()
      .min(1)
      .refine((source) => Buffer.byteLength(source, 'utf8') <= MAX_PACKAGE_METADATA_BYTES, {
        message: 'scriptContent exceeds the 100 KiB per-file JavaScript limit',
      })
      .optional(),
    packagePath: z.string().min(1).max(1024).optional(),
    test: z
      .object({
        config: z.record(z.string(), z.json()).optional(),
        timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const inline = args.manifest !== undefined || args.scriptContent !== undefined;
    if (args.packagePath !== undefined && inline) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Provide either { manifest, scriptContent } (single-file node) or packagePath (folder package), not both.',
      });
    } else if (
      args.packagePath === undefined &&
      (args.manifest === undefined || args.scriptContent === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Provide manifest and scriptContent together for a single-file node, or packagePath for a folder package.',
      });
    }
  });

export type RegisterNodeArgs = z.infer<typeof registerNodeArgsSchema>;
export type RegisterNodeTest = RegisterNodeArgs['test'];

export type RegisterNodeInput =
  | {
      source: 'inline';
      manifest: RegisterNodeManifest;
      scriptContent: string;
      test?: RegisterNodeTest;
    }
  | { source: 'package'; packagePath: string; test?: RegisterNodeTest };

/** Safe after schema validation: the XOR refinement guarantees exactly one source shape. */
export function normalizeRegisterNodeArgs(args: RegisterNodeArgs): RegisterNodeInput {
  if (args.packagePath !== undefined) {
    return { source: 'package', packagePath: args.packagePath, test: args.test };
  }
  if (args.manifest === undefined || args.scriptContent === undefined) {
    throw new Error('normalizeRegisterNodeArgs requires schema-validated args');
  }
  return {
    source: 'inline',
    manifest: args.manifest,
    scriptContent: args.scriptContent,
    test: args.test,
  };
}

export const MANAGED_NODE_PACKAGE_JSON = '{\n  "type": "module"\n}\n';
export const MAX_REGISTER_NODE_PER_SESSION = 20;
export const GLOBAL_REGISTER_NODE_SESSION_KEY = '__global_register__';

const registerNodeCallCounts = new Map<string, number>();

export function tryAcquireRegisterNodeSlot(sessionKey: string): boolean {
  const count = registerNodeCallCounts.get(sessionKey) ?? 0;
  if (count >= MAX_REGISTER_NODE_PER_SESSION) return false;
  registerNodeCallCounts.set(sessionKey, count + 1);
  return true;
}

/** Clear per-session register_node call counts (call from clearCurrentExecutionChat). */
export function resetRegisterNodeCount(executionId?: string): void {
  if (executionId === undefined) {
    registerNodeCallCounts.clear();
    return;
  }
  registerNodeCallCounts.delete(executionId);
}

const REGISTER_NODE_WARN_PROCESS_STDIN = /\bprocess\.stdin\b/;
const REGISTER_NODE_WARN_READLINE = /\breadline\b/;
const REGISTER_NODE_WARN_STATUS_SUCCESS = /["']status["']\s*:\s*["']success["']/;
const REGISTER_NODE_WARN_OUTPUTS_KEY = /["']outputs["']\s*:/;

/** Soft warnings for common custom-node stdin and output-shape mistakes. */
export function collectRegisterNodeScriptWarnings(scriptContent: string): string[] {
  const warnings: string[] = [];
  if (
    REGISTER_NODE_WARN_PROCESS_STDIN.test(scriptContent) ||
    REGISTER_NODE_WARN_READLINE.test(scriptContent)
  ) {
    warnings.push(
      'Script appears to read stdin for config. Frink passes config as one JSON CLI argument at process.argv[2]. Reading stdin can hang until timeout.',
    );
  }
  if (
    REGISTER_NODE_WARN_STATUS_SUCCESS.test(scriptContent) &&
    REGISTER_NODE_WARN_OUTPUTS_KEY.test(scriptContent)
  ) {
    warnings.push(
      'Script may use a { status, outputs } wrapper on stdout. Frink expects a flat JSON object (top-level keys become step outputs like {{previous.count}}), not nested under outputs.',
    );
  }
  return warnings;
}

export type ExistingRegisteredNode = {
  entrypoint: string;
  sourceMode: 'legacy' | 'package';
};

const installedPackageSchema = z
  .object({
    version: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    resources: z.array(z.string()),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
const errorCodeSchema = z.object({ code: z.string() });

function hasErrorCode(cause: unknown, code: string): boolean {
  const parsed = errorCodeSchema.safeParse(cause);
  return parsed.success && parsed.data.code === code;
}

export async function readExistingRegisteredNode(
  dir: string,
): Promise<ExistingRegisteredNode | null> {
  try {
    const manifest = z
      .record(z.string(), z.json())
      .parse(
        JSON.parse(
          (
            await readBoundedInstalledFile(dir, 'manifest.json', MAX_PACKAGE_METADATA_BYTES)
          ).toString('utf8'),
        ),
      );
    const spec = parseCustomNodeEntrypointSpec(manifest);
    resolveContainedCustomNodePath(dir, spec.entrypoint);
    const sourceMode = manifest.frinkPackage === undefined ? 'legacy' : 'package';
    if (manifest.frinkPackage !== undefined) installedPackageSchema.parse(manifest.frinkPackage);
    return {
      ...spec,
      sourceMode,
    };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw new Error(
      `Cannot safely update the existing custom node: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateJavaScriptSource(source: string, entrypoint: string): string | null {
  try {
    parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return `JavaScript validation failed for "${entrypoint}": ${message}. Use plain ESM JavaScript.`;
  }
}
