import { z } from 'zod';
import type { JsonSchemaObject } from './json-schema-to-manifest-inputs';

const safeKey = z
  .string()
  .min(1)
  .max(100)
  .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key));
const pathSchema = z
  .array(z.union([safeKey, z.number().int().min(0).max(1000)]))
  .min(1)
  .max(16);

/** Any value that survived JSON, and the object form of it. */
const jsonNode = z.json();
const jsonObject = z.record(z.string(), z.json());
export type JsonNode = z.infer<typeof jsonNode>;
export type JsonObject = z.infer<typeof jsonObject>;
const refNode = z.object({ $ref: z.string() }).catchall(z.json());

/** Traverse only existing own properties; never synthesize containers or follow prototypes. */
function ownValue(value: JsonNode, key: string | number): JsonNode {
  if (Object(value) !== value || !Object.hasOwn(Object(value), key))
    throw new Error('Preset path is missing.');
  // SAFETY: the guard above confirmed an own key on a live JSON container.
  return (value as JsonObject)[String(key)] ?? null;
}

export const mcpToolPresetSchema = z
  .object({
    inputPath: pathSchema,
    fixedArgs: z.record(z.string(), z.json()),
    /** Vendor-documented operation fields when tools/list exposes only an open request object. */
    inputSchema: z
      .object({
        type: z.literal('object'),
        properties: z.record(safeKey, z.record(z.string(), z.json())),
        required: z.array(safeKey).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(({ inputPath, fixedArgs }) => {
    try {
      const slot = inputPath.reduce<JsonNode>(ownValue, fixedArgs);
      const object = jsonObject.safeParse(slot);
      return object.success && Object.keys(object.data).length === 0;
    } catch {
      return false;
    }
  }, 'Preset input path must name an existing empty object.');

export type McpToolPreset = z.infer<typeof mcpToolPresetSchema>;

/** Fixed wrapper values never pass through templating or merge with user inputs. */
export function wrapMcpPresetArgs(preset: McpToolPreset, args: JsonObject): JsonObject {
  const { inputPath, fixedArgs } = mcpToolPresetSchema.parse(preset);
  const wrapped = structuredClone(fixedArgs);
  const parent = inputPath.slice(0, -1).reduce<JsonNode>(ownValue, wrapped);
  if (!(jsonObject.safeParse(parent).success || Array.isArray(parent)))
    throw new Error('Preset parent is not a container.');
  Reflect.set(Object(parent), inputPath[inputPath.length - 1], structuredClone(args));
  return wrapped;
}

/** Resolve only local JSON pointers used by the hosted schema, with a finite cycle/depth limit. */
function resolveSchema(root: JsonNode, value: JsonNode): JsonObject {
  const seen = new Set<string>();
  for (let node = refNode.safeParse(value); node.success; node = refNode.safeParse(value)) {
    const ref = node.data.$ref;
    if (!ref.startsWith('#/') || seen.has(ref) || seen.size >= 16)
      throw new Error('Preset schema reference is unsupported.');
    seen.add(ref);
    const path = ref
      .slice(2)
      .split('/')
      .map((key) => safeKey.parse(key.replace(/~1/g, '/').replace(/~0/g, '~')));
    const target = path.reduce<JsonNode>(ownValue, root);
    const { $ref: _ref, ...siblings } = node.data;
    value = { ...resolveObject(target), ...siblings };
  }
  return resolveObject(value);
}

function resolveObject(value: JsonNode): JsonObject {
  const object = jsonObject.safeParse(value);
  if (!object.success) throw new Error('Preset schema is not an object.');
  return object.data;
}

type PresetSchemaResult = { ok: true; schema: JsonSchemaObject } | { ok: false; reason: string };

/** Select one operation's object schema; ambiguous or missing branches must preserve the old cache. */
export function selectMcpPresetSchema(root: JsonNode, preset: McpToolPreset): PresetSchemaResult {
  try {
    let schema = resolveSchema(root, root);
    for (const segment of mcpToolPresetSchema.parse(preset).inputPath) {
      if (z.number().safeParse(segment).success) {
        if (schema.type !== 'array') throw new Error('Preset schema path is not an array.');
        schema = resolveSchema(root, schema.items ?? null);
        continue;
      }
      const variants = Array.isArray(schema.anyOf)
        ? schema.anyOf.map((branch) => resolveSchema(root, branch))
        : [schema];
      const matches = variants.filter(
        (branch) =>
          branch.type === 'object' &&
          jsonObject.safeParse(branch.properties).success &&
          Object.hasOwn(Object(branch.properties), segment),
      );
      if (matches.length !== 1) throw new Error('Preset schema path is missing or ambiguous.');
      schema = resolveSchema(root, ownValue(matches[0].properties ?? null, segment));
    }
    if (preset.inputSchema) {
      const open = jsonObject.safeParse(schema.additionalProperties);
      const properties = jsonObject.safeParse(schema.properties);
      if (
        schema.type !== 'object' ||
        !(
          schema.additionalProperties === true ||
          (open.success && Object.keys(open.data).length === 0)
        ) ||
        !properties.success ||
        Object.keys(properties.data).length > 0
      )
        throw new Error('Bundled operation fields require an open, untyped vendor request object.');
      schema = preset.inputSchema;
    }
    const fields = jsonObject.safeParse(schema.properties);
    if (schema.type !== 'object' || !fields.success)
      throw new Error('Preset input schema is not an object with properties.');
    const properties = Object.fromEntries(
      Object.entries(fields.data).map(([name, field]) => [
        safeKey.parse(name),
        resolveSchema(root, field),
      ]),
    );
    return { ok: true, schema: { ...schema, properties } };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Preset schema selection failed.',
    };
  }
}
