/**
 * Pure resolution of the `{{previous.*}}` output-variable schema shown in the
 * Available Variables panel, derived from a predecessor block's type.
 *
 * Free of React/trpc so it can be unit-tested in isolation; the panel component
 * supplies the resolved custom-node schemas via options.
 */

import {
  CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA,
  OUTPUT_SCHEMAS,
  type OutputFieldSchema,
  type RunCommandExpectedOutputs,
  resolveRunCommandOutputSchema,
} from '../../../../../../shared/lib/output-schemas';

export type CustomNodeSchema = {
  topLevelFields: OutputFieldSchema[];
  /** Sub-fields of the first array-typed output, for {{previous.currentItem.*}} use downstream of fan_out */
  currentItemSubFields?: OutputFieldSchema[];
  /** True if the first array field has no items definition (array of primitives) */
  currentItemIsPrimitive?: boolean;
};

export type OutputSchemaResult = {
  fields: OutputFieldSchema[];
  currentItemFields?: OutputFieldSchema[];
  currentItemIsPrimitive?: boolean;
  note?: string;
};

export type OutputSchemaOptions = {
  fanOutSourceBlockType?: string | null;
  customNodeSchema?: CustomNodeSchema | null;
  fanOutSourceCustomNodeSchema?: CustomNodeSchema | null;
  /** expectedOutputs from the predecessor run_command's config (when blockType is run_command) */
  expectedOutputs?: RunCommandExpectedOutputs | null;
  /** expectedOutputs from the grandparent run_command's config (for condition passthrough) */
  fanOutSourceExpectedOutputs?: RunCommandExpectedOutputs | null;
};

/** Output schema for a non-built-in block type (a custom node). */
function customNodeOutputSchema(customNodeSchema?: CustomNodeSchema | null): OutputSchemaResult {
  if (customNodeSchema) {
    return {
      fields: customNodeSchema.topLevelFields,
      note: "Fields declared in this node's manifest. If your script prints additional JSON fields, they are also available as {{previous.<field>}}.",
    };
  }
  return {
    fields: CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA,
    note: 'These are guaranteed fields. If your script prints JSON to stdout, every field in that JSON is also available as {{previous.<field>}}. Declare an "outputs" schema in your manifest.json to see specific field chips here.',
  };
}

function runCommandOutputSchema(
  fields: OutputFieldSchema[],
  expectedOutputs?: RunCommandExpectedOutputs | null,
): OutputSchemaResult {
  if (expectedOutputs && Object.keys(expectedOutputs).length > 0) {
    return {
      fields: resolveRunCommandOutputSchema(expectedOutputs),
      note: 'Declared output fields. Other JSON keys printed to stdout are also accessible as {{previous.<field>}} but will warn during validation.',
    };
  }
  return {
    fields,
    note: 'Guaranteed fields only. This command outputs dynamic JSON — add `expectedOutputs` to the node config to declare what fields it produces, making them visible as chips here.',
  };
}

function fanOutOutputSchema(
  fields: OutputFieldSchema[],
  fanOutSourceBlockType?: string | null,
  fanOutSourceCustomNodeSchema?: CustomNodeSchema | null,
): OutputSchemaResult {
  if (fanOutSourceCustomNodeSchema) {
    if (fanOutSourceCustomNodeSchema.currentItemIsPrimitive) {
      return {
        fields,
        currentItemFields: [],
        currentItemIsPrimitive: true,
        note: 'The upstream node iterates over an array of primitives — use {{previous.currentItem}} directly.',
      };
    }
    if (fanOutSourceCustomNodeSchema.currentItemSubFields?.length) {
      return { fields, currentItemFields: fanOutSourceCustomNodeSchema.currentItemSubFields };
    }
    return {
      fields,
      currentItemFields: fanOutSourceCustomNodeSchema.topLevelFields,
      note: "Iterating over this node's top-level outputs — use {{previous.currentItem.<field>}}.",
    };
  }

  const sourceIsBuiltIn = fanOutSourceBlockType && fanOutSourceBlockType in OUTPUT_SCHEMAS;
  const sourceIsDynamic =
    !fanOutSourceBlockType || !sourceIsBuiltIn || fanOutSourceBlockType === 'run_command';

  if (!sourceIsDynamic && fanOutSourceBlockType) {
    return { fields, currentItemFields: OUTPUT_SCHEMAS[fanOutSourceBlockType] ?? [] };
  }

  return {
    fields,
    currentItemFields: [],
    note: 'The upstream node outputs dynamic JSON — use {{previous.currentItem.<field>}} with the actual field names from your script output. For example: {{previous.currentItem.headRefName}}, {{previous.currentItem.title}}, {{previous.currentItem.url}}.',
  };
}

/** Passthrough fields a condition merges from its grandparent, plus whether they are dynamic. */
function conditionPassthroughFields(
  grandparentBlockType?: string | null,
  grandparentCustomSchema?: CustomNodeSchema | null,
  grandparentExpectedOutputs?: RunCommandExpectedOutputs | null,
): { fields: OutputFieldSchema[]; hasDynamic: boolean } {
  if (!grandparentBlockType) return { fields: [], hasDynamic: false };

  if (!(grandparentBlockType in OUTPUT_SCHEMAS)) {
    // Custom node — use manifest-declared fields if available, else fallback
    return {
      fields: grandparentCustomSchema?.topLevelFields ?? CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA,
      hasDynamic: !grandparentCustomSchema,
    };
  }

  if (grandparentBlockType === 'run_command') {
    // Use declared expectedOutputs if available; else fall back to static schema
    if (grandparentExpectedOutputs && Object.keys(grandparentExpectedOutputs).length > 0) {
      return {
        fields: resolveRunCommandOutputSchema(grandparentExpectedOutputs),
        hasDynamic: false,
      };
    }
    return { fields: OUTPUT_SCHEMAS.run_command ?? [], hasDynamic: true };
  }

  return { fields: OUTPUT_SCHEMAS[grandparentBlockType] ?? [], hasDynamic: false };
}

function conditionOutputSchema(
  fields: OutputFieldSchema[],
  fanOutSourceBlockType?: string | null,
  fanOutSourceCustomNodeSchema?: CustomNodeSchema | null,
  fanOutSourceExpectedOutputs?: RunCommandExpectedOutputs | null,
): OutputSchemaResult {
  // At runtime condition outputs { ...upstream, result }, so merge grandparent
  // passthrough fields with condition's own `result` (which takes precedence).
  const { fields: passthroughFields, hasDynamic } = conditionPassthroughFields(
    fanOutSourceBlockType,
    fanOutSourceCustomNodeSchema,
    fanOutSourceExpectedOutputs,
  );

  return {
    fields: [...passthroughFields.filter((f) => f.key !== 'result'), ...fields],
    note: hasDynamic
      ? 'Dynamic fields are also available: if the upstream command printed JSON to stdout, those keys are also accessible as {{previous.<field>}}.'
      : undefined,
  };
}

export function getOutputSchemaForBlockType(
  blockType: string,
  options: OutputSchemaOptions = {},
): OutputSchemaResult {
  const {
    fanOutSourceBlockType,
    customNodeSchema,
    fanOutSourceCustomNodeSchema,
    expectedOutputs,
    fanOutSourceExpectedOutputs,
  } = options;

  if (!(blockType in OUTPUT_SCHEMAS)) return customNodeOutputSchema(customNodeSchema);

  const fields = OUTPUT_SCHEMAS[blockType] ?? [];

  switch (blockType) {
    case 'run_command':
      return runCommandOutputSchema(fields, expectedOutputs);
    case 'fan_out':
      return fanOutOutputSchema(fields, fanOutSourceBlockType, fanOutSourceCustomNodeSchema);
    case 'condition':
      return conditionOutputSchema(
        fields,
        fanOutSourceBlockType,
        fanOutSourceCustomNodeSchema,
        fanOutSourceExpectedOutputs,
      );
    case 'http_request':
      return {
        fields,
        note: 'headers is an object — use dot notation: {{previous.headers.content-type}}',
      };
    default:
      return { fields };
  }
}
