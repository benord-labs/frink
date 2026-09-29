import { z } from 'zod';
import type { PermissionPresentation } from '../../types/permissions';

/** Recursive schemas such as `z.json()` accept cyclic input, which JSON cannot represent. */
function isSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

const permissionPresentationSchema: z.ZodType<PermissionPresentation> = z
  .object({
    type: z.literal('custom-node-registration'),
    packagePath: z.string().optional(),
    action: z.enum(['create', 'replace']),
    replacesPackage: z.boolean().optional(),
    node: z
      .object({
        name: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        version: z.string().optional(),
        entrypoint: z.string(),
      })
      .strict(),
    source: z.object({ current: z.string(), previous: z.string().optional() }).strict(),
    modules: z.array(
      z
        .object({
          path: z.string(),
          current: z.string(),
          previous: z.string().optional(),
          change: z.enum(['added', 'changed', 'removed', 'unchanged']),
        })
        .strict(),
    ),
    resources: z.array(
      z
        .object({
          path: z.string(),
          bytes: z.number().int().nonnegative().safe(),
          change: z.enum(['added', 'changed', 'removed', 'unchanged']),
        })
        .strict(),
    ),
    credentialNames: z.array(z.string()),
    test: z
      .object({
        config: z.record(z.string(), z.json()).refine(isSerializable),
        timeoutMs: z.number().int().positive().safe(),
      })
      .strict()
      .optional(),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    packageBytes: z.number().int().nonnegative().safe(),
    warning: z.string(),
  })
  .strict();

export function isPermissionPresentation(value: PermissionPresentation | undefined): boolean {
  if (value === undefined) return false;
  try {
    return permissionPresentationSchema.safeParse(value).success;
  } catch {
    return false;
  }
}
