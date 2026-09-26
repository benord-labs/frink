import { z } from 'zod';
import { isPlainObject } from '../case-converter/is-transformable';
/**
 * Projects an MCP tool `inputSchema` onto the flat inputs map SchemaFields renders: scalars, typed enum
 * `options`, structured values as raw `json` text; a property with no usable type lands in `unsupportedFields`.
 */

export type ManifestInputProjection = {
  type: 'string' | 'number' | 'boolean' | 'json';
  required?: boolean;
  default?: unknown;
  label?: string;
  /** The property's full description, rendered as help text under the field — never squeezed into a placeholder, which truncates it. */
  description?: string;
  /** Enum values in their JSON type, rendered as a static select — never a `--list-options` script, which a plugin node has no entrypoint to run. */
  options?: Array<string | number | boolean>;
};

export type JsonSchemaObject = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
};

export type ManifestInputsProjection = {
  inputs: Record<string, ManifestInputProjection>;
  unsupportedFields: string[];
};

const FIELD_TYPES = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  object: 'json',
  array: 'json',
} satisfies Record<string, ManifestInputProjection['type']>;
const FIELD_TYPE_KEY = z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']);
const COMPOSITION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const;

/** Same-typed scalar enums keep their JSON type; the first schema that accepts the list names it. */
const ENUM_PROJECTIONS: ReadonlyArray<
  [z.ZodType<Array<string | number | boolean>>, ManifestInputProjection['type']]
> = [
  [z.array(z.string()).min(1), 'string'],
  [z.array(z.number()).min(1), 'number'],
  [z.array(z.boolean()).min(1), 'boolean'],
];

/** Base projection for one property, or null when it cannot be rendered as a flat field. */
function projectPropertyType(property: Record<string, unknown>): ManifestInputProjection | null {
  const key = FIELD_TYPE_KEY.safeParse(property.type);
  // A structured value is raw JSON whatever else the schema says about it (an enum of objects included).
  if (key.success && FIELD_TYPES[key.data] === 'json') return { type: 'json' };
  // A mixed or empty enum matches no schema and is unrepresentable.
  if (Array.isArray(property.enum)) {
    const hit = ENUM_PROJECTIONS.find(([schema]) => schema.safeParse(property.enum).success);
    return hit ? { type: hit[1], options: hit[0].parse(property.enum) } : null;
  }
  // A composition has no single widget; raw JSON is the one honest control for it.
  if (
    COMPOSITION_KEYS.some((composition) => {
      const branches = property[composition];
      return Array.isArray(branches) && branches.length > 0;
    })
  ) {
    return { type: 'json' };
  }
  return key.success ? { type: FIELD_TYPES[key.data] } : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Full projection for one property, or null when it belongs in unsupportedFields. */
function projectProperty(
  property: Record<string, unknown>,
  isRequired: boolean,
): ManifestInputProjection | null {
  const projected = projectPropertyType(property);
  if (projected === null) return null;
  if (isRequired) projected.required = true;
  if (property.default !== undefined) projected.default = property.default;
  const label = nonEmptyString(property.title);
  if (label !== undefined) projected.label = label;
  const description = nonEmptyString(property.description);
  if (description !== undefined) projected.description = description;
  return projected;
}

export function jsonSchemaToManifestInputs(schema: JsonSchemaObject): ManifestInputsProjection {
  const inputs: Record<string, ManifestInputProjection> = {};
  const unsupportedFields: string[] = [];
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : [],
  );

  for (const [key, rawProperty] of Object.entries(properties)) {
    const projected = isPlainObject(rawProperty)
      ? projectProperty(rawProperty, required.has(key))
      : null;
    if (projected === null) unsupportedFields.push(key);
    else inputs[key] = projected;
  }

  return { inputs, unsupportedFields };
}
