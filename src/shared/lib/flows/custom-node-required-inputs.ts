/**
 * Design-time check for custom-node inputs a manifest declares `required` but the saved node config
 * does not satisfy. One predicate, several consumers: the flow editor's config panel, the Ghost Run
 * rehearsal, and the MCP pre-run gate all report the same set.
 *
 * This is the DESIGN-TIME half only. The authority is `buildCustomNodeInputConfig`
 * (src/main/lib/custom-nodes/runtime.ts), which re-checks AFTER template rendering and fails the
 * step. A value holding a `{{...}}` placeholder is therefore skipped here — whether it resolves to
 * anything is not knowable until the run — so a clean result means "nothing is provably missing",
 * not "this node will run".
 */

import { z } from 'zod';
import type { JsonValue } from '../../types/permissions';
import { TEMPLATE_VARIABLE_PATTERN } from '../template-constants';

/** Any value a manifest or a saved node config can hold — both are plain JSON. */
export type { JsonValue } from '../../types/permissions';

/**
 * Reserved: the project is chosen by a dedicated control and may be inherited from the flow's
 * `settings.defaultProjectId`, so it is never a node-local required input. Shared with the same
 * skip in buildCustomNodeInputConfig.
 */
export const RESERVED_INPUT_KEY = 'projectId';

/** The fields of one declared input this check reads. Unlisted manifest keys are ignored. */
const JSON_VALUE_SCHEMA: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JSON_VALUE_SCHEMA),
    z.record(z.string(), JSON_VALUE_SCHEMA),
  ]),
);

/** An `inputs` block is an object of declarations; anything else carries no declarations at all. */
const INPUTS_BLOCK_SCHEMA = z.record(z.string(), JSON_VALUE_SCHEMA);

const DECLARATION_SCHEMA = z.object({
  type: z.string().optional(),
  required: z.boolean().optional(),
  default: JSON_VALUE_SCHEMA.optional(),
});

/** One input as a manifest declares it, once parsed. */
export type ManifestInputDeclaration = {
  /** Declared value type. Read by the runtime's coercion, not by this check. */
  type?: string;
  required?: boolean;
  default?: JsonValue;
};

/** Declared inputs of one custom node, keyed by input name. */
export type ManifestInputDeclarations = Record<string, ManifestInputDeclaration>;

/** Declared inputs of every known custom node, keyed by block type (the node name). */
export type CustomNodeInputsByType = ReadonlyMap<string, ManifestInputDeclarations>;

/**
 * Parse a manifest's raw `inputs` block into declarations this module can trust.
 *
 * Discovery keeps manifest inputs as unparsed JSON, so this is the I/O boundary. A declaration with
 * a malformed field keeps its well-formed ones rather than being dropped — dropping the whole input
 * would silently withhold the user's configured value from the script. A manifest declaring
 * `"required": "yes"` is treated as not-required, which discovery separately warns about.
 */
export function parseManifestInputDeclarations(rawInputs: JsonValue): ManifestInputDeclarations {
  const block = INPUTS_BLOCK_SCHEMA.safeParse(rawInputs);
  if (!block.success) return {};
  return Object.fromEntries(
    Object.entries(block.data).map(([key, rawSchema]) => {
      const declaration = DECLARATION_SCHEMA.safeParse(rawSchema);
      return [key, declaration.success ? declaration.data : salvageDeclaration(rawSchema)];
    }),
  );
}

/** Per-field fallback for a declaration that failed DECLARATION_SCHEMA: each malformed field
 *  degrades independently instead of the whole declaration being dropped. */
const SALVAGED_DECLARATION_SCHEMA = z.object({
  type: z.string().optional().catch(undefined),
  required: z.literal(true).optional().catch(undefined),
  default: JSON_VALUE_SCHEMA.optional(),
});

/** The well-formed fields of a malformed declaration; `{}` for non-objects. */
function salvageDeclaration(rawSchema: JsonValue): ManifestInputDeclaration {
  const salvaged = SALVAGED_DECLARATION_SCHEMA.safeParse(rawSchema);
  return salvaged.success ? salvaged.data : {};
}

/**
 * No usable substance: absent, null, or a string that is empty once trimmed.
 *
 * Shared with the runtime so both halves agree on what "blank" means — a divergence here would let
 * the editor green-light a value the run rejects, or the reverse.
 */
export function isBlankConfigValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  const text = z.string().safeParse(value);
  return text.success && text.data.trim() === '';
}

/**
 * A default only satisfies a required input when it carries substance. Declaring an input required
 * and defaulting it to nothing is contradictory, and treating it as satisfied would green-light a
 * run the runtime rejects. Mirrors the same rule in resolveInputDefault.
 */
function hasUsableDefault(declaration: ManifestInputDeclaration): boolean {
  return !isBlankConfigValue(declaration.default);
}

/** True when the value carries a `{{...}}` placeholder, i.e. it is only knowable at run time. */
function isTemplated(value: JsonValue | undefined): boolean {
  const text = z.string().safeParse(value);
  return text.success && new RegExp(TEMPLATE_VARIABLE_PATTERN).test(text.data);
}

/**
 * Names of declared-required inputs that hold no usable value. Excludes anything templated (see the
 * module note), anything carrying a usable manifest default, and the reserved project key.
 *
 * @returns input keys in manifest declaration order; empty when nothing is provably missing.
 */
export function findMissingRequiredCustomNodeInputs(
  inputs: ManifestInputDeclarations | undefined,
  config: Record<string, JsonValue> | undefined,
): string[] {
  if (!inputs) return [];
  const missing: string[] = [];
  for (const [key, declaration] of Object.entries(inputs)) {
    if (key === RESERVED_INPUT_KEY) continue;
    if (declaration.required !== true || hasUsableDefault(declaration)) continue;

    const value = config?.[key];
    if (isTemplated(value)) continue;
    if (isBlankConfigValue(value)) missing.push(key);
  }
  return missing;
}
