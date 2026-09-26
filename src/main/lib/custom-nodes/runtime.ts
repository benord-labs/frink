import { realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { z } from 'zod';
import {
  isBlankConfigValue,
  type JsonValue,
  type ManifestInputDeclaration,
  parseManifestInputDeclarations,
  RESERVED_INPUT_KEY,
} from '../../../shared/lib/flows/custom-node-required-inputs';

export const CUSTOM_NODE_ENTRYPOINT_EXTENSION = '.js' as const;
export const CUSTOM_NODE_RUNTIME_MIGRATION_MESSAGE =
  '"runtime" is no longer supported in custom-node manifests. Remove it and use a ".js" entrypoint; Frink runs custom nodes with its bundled Node.js.';
const PATH_SEPARATOR_RE = /[\\/]/;

export function isCustomNodeEntrypoint(entrypoint: string): boolean {
  return extname(entrypoint) === CUSTOM_NODE_ENTRYPOINT_EXTENSION;
}

function assertRelativeEntrypoint(entrypoint: string): void {
  if (isAbsolute(entrypoint) || win32.isAbsolute(entrypoint)) {
    throw new Error(`[custom-node-runtime] entrypoint must be relative: ${entrypoint}`);
  }

  if (entrypoint.split(PATH_SEPARATOR_RE).includes('..')) {
    throw new Error(`[custom-node-runtime] entrypoint cannot contain "..": ${entrypoint}`);
  }
}

function isOutsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

type CustomNodeEntrypointSpec = {
  entrypoint: string;
};

/** Parse the JavaScript entrypoint contract shared by discovery and safe in-place updates. */
export function parseCustomNodeEntrypointSpec(raw: unknown): CustomNodeEntrypointSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('manifest.json is not a JSON object');
  }
  const manifest = raw as Record<string, unknown>;
  if (Object.hasOwn(manifest, 'runtime')) {
    throw new Error(CUSTOM_NODE_RUNTIME_MIGRATION_MESSAGE);
  }
  if (typeof manifest.entrypoint !== 'string' || manifest.entrypoint.trim() === '') {
    throw new Error('missing or invalid "entrypoint"');
  }
  const entrypoint = manifest.entrypoint.trim();
  if (!isCustomNodeEntrypoint(entrypoint)) {
    throw new Error(
      `invalid "entrypoint": custom nodes must use a "${CUSTOM_NODE_ENTRYPOINT_EXTENSION}" entrypoint run by Frink's bundled Node.js`,
    );
  }
  return { entrypoint };
}

/**
 * Declared manifest input types. The editor picks a widget from these and the dispatch boundary
 * coerces template-rendered strings back to them.
 *
 * Anything else (including the retired "select", which never had an implementation — dynamic
 * pickers are driven by `listOptions`) is treated as "string", matching how the editor already
 * renders an unrecognised type. Discovery surfaces a warning rather than rejecting the manifest,
 * so a node authored against older docs keeps working.
 */
const CUSTOM_NODE_INPUT_TYPES = ['string', 'number', 'boolean'] as const;

export type CustomNodeInputType = (typeof CUSTOM_NODE_INPUT_TYPES)[number];

const INPUT_TYPES = new Set<string>(CUSTOM_NODE_INPUT_TYPES);

const NUMBER_SCHEMA = z.coerce.number();
/**
 * z.stringbool, never z.coerce.boolean: the latter is Boolean(value), so the string "false" — which
 * is exactly what a `{{previous.flag}}` template renders a false upstream value into — becomes true.
 */
const BOOLEAN_SCHEMA = z.stringbool();

/**
 * Outcome of coercing one config value to its declared type.
 *
 * `missing` is distinct from an error: a non-string input that rendered to empty has no value at
 * all, and the caller applies the manifest default rather than fabricating one.
 */
export type CoercedInput =
  | { kind: 'value'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'error'; error: string };

/** The declared type of one manifest input, defaulting to "string" for absent or unknown types. */
export function readDeclaredInputType(rawSchema: unknown): CustomNodeInputType {
  if (typeof rawSchema !== 'object' || rawSchema === null || Array.isArray(rawSchema)) {
    return 'string';
  }
  const declared = (rawSchema as Record<string, unknown>).type;
  return typeof declared === 'string' && INPUT_TYPES.has(declared)
    ? (declared as CustomNodeInputType)
    : 'string';
}

/**
 * Coerce one already-template-rendered config value to its manifest-declared type.
 *
 * Templates always render to a string, so a `number`/`boolean` input bound to `{{previous.x}}`
 * arrives here as text. Values that are already the declared type — written directly by the
 * editor's typed widgets — pass through untouched.
 */
export function coerceCustomNodeInputValue(
  declaredType: CustomNodeInputType,
  value: unknown,
): CoercedInput {
  if (declaredType === 'string') return { kind: 'value', value };

  // Already the declared type — the editor's typed widgets write these directly.
  if (declaredType === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'value', value };
  }
  if (declaredType === 'boolean' && typeof value === 'boolean') return { kind: 'value', value };

  // A non-string literal of the wrong type reaches here from frink_flows_patch, which writes config
  // JSON with no editor widget in between. The declared type governs those too.
  if (typeof value !== 'string') {
    return { kind: 'error', error: `expected ${declaredType}, got ${describeValue(value)}` };
  }

  // Parse the TRIMMED text: command stdout is newline-terminated, so {{previous.output}} routinely
  // renders "true\n". z.coerce.number trims internally but z.stringbool does not, and coercion must
  // not depend on which of the two a manifest happened to declare.
  const text = value.trim();

  // A present-but-null upstream value renders to '', and Number('') is 0 — coercing here would ship
  // a fabricated zero that reads as a real reading. Treat it as absent so the default applies.
  if (text === '') return { kind: 'missing' };

  const schema = declaredType === 'number' ? NUMBER_SCHEMA : BOOLEAN_SCHEMA;
  const parsed = schema.safeParse(text);
  return parsed.success
    ? { kind: 'value', value: parsed.data }
    : { kind: 'error', error: `expected ${declaredType}, got ${describeValue(value)}` };
}

/** Render a rejected value for an error message; JSON.stringify alone drops undefined. */
function describeValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * Non-fatal manifest problems in the `inputs` block, surfaced through discovery's warnings channel.
 * Never rejects: an installed node with an odd declared type still loads and renders as text.
 */
/** An input declaring a type the runtime does not implement still loads, as text. */
function unsupportedTypeWarning(key: string, schema: RawManifestInput): string | null {
  const parsed = z.string().safeParse(schema.type);
  if (!parsed.success || INPUT_TYPES.has(parsed.data)) return null;
  const declared = parsed.data;
  const pickerHint = declared === 'select' ? ', or "listOptions": true for a dynamic picker' : '';
  return `Input "${key}" declares unsupported type "${declared}" — treated as string. Use ${CUSTOM_NODE_INPUT_TYPES.join(', ')}${pickerHint}`;
}

/** Required-ness is strictly boolean, so anything else would silently read as optional. */
function nonBooleanRequiredWarning(key: string, schema: RawManifestInput): string | null {
  if (!Object.hasOwn(schema, 'required') || z.boolean().safeParse(schema.required).success) {
    return null;
  }
  return `Input "${key}" declares a non-boolean "required" (${describeValue(schema.required)}) — treated as optional. Use true or false.`;
}

/** A default that cannot become its own declared type would fail every run that relies on it. */
function mismatchedDefaultWarning(key: string, schema: RawManifestInput): string | null {
  if (!Object.hasOwn(schema, 'default')) return null;
  const coerced = coerceCustomNodeInputValue(readDeclaredInputType(schema), schema.default);
  return coerced.kind === 'error'
    ? `Input "${key}" default does not match its declared type — ${coerced.error}`
    : null;
}

/** One input's declaration exactly as the manifest wrote it, before any field is trusted. */
type RawManifestInput = Record<string, JsonValue>;

const RAW_MANIFEST_INPUT_SCHEMA = z.record(
  z.string(),
  z.custom<JsonValue>(() => true),
);

/** Non-fatal problems with ONE declared input. Never rejects — the node still loads. */
function manifestInputWarnings(key: string, rawSchema: JsonValue): string[] {
  const schema = RAW_MANIFEST_INPUT_SCHEMA.safeParse(rawSchema);
  if (!schema.success) return [];
  return [
    unsupportedTypeWarning(key, schema.data),
    nonBooleanRequiredWarning(key, schema.data),
    mismatchedDefaultWarning(key, schema.data),
  ].filter((w): w is string => w !== null);
}

export function collectManifestInputWarnings(inputs: Record<string, unknown>): string[] {
  // SAFETY: manifest JSON straight off disk; every field is parsed before it is read.
  return Object.entries(inputs as Record<string, JsonValue>).flatMap(([key, rawSchema]) =>
    manifestInputWarnings(key, rawSchema),
  );
}

export type CustomNodeInputConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

/** A manifest default, or undefined when the input declares none. */
function readInputDefault(rawSchema: unknown): { present: boolean; value: unknown } {
  if (
    typeof rawSchema !== 'object' ||
    rawSchema === null ||
    Array.isArray(rawSchema) ||
    !Object.hasOwn(rawSchema, 'default')
  ) {
    return { present: false, value: undefined };
  }
  return { present: true, value: (rawSchema as Record<string, unknown>).default };
}

type ResolvedInput =
  | { kind: 'value'; value: unknown }
  /** `renderedEmpty` distinguishes "never configured" from "a template resolved to nothing", so a
   *  required-input failure can tell the user whether to fix this step's config or its upstream. */
  | { kind: 'omit'; renderedEmpty: boolean }
  | { kind: 'error'; error: string };

/**
 * Resolve one declared input: the configured value if it survives coercion, else the declared
 * default, else nothing. A value that rendered to empty counts as absent, not as zero/false.
 */
function resolveDeclaredInput(
  key: string,
  declaration: ManifestInputDeclaration,
  config: Record<string, unknown>,
  required: boolean,
): ResolvedInput {
  const declaredType = readDeclaredInputType(declaration);
  const configured = Object.hasOwn(config, key) ? config[key] : undefined;

  if (configured !== undefined) {
    const coerced = coerceCustomNodeInputValue(declaredType, configured);
    if (coerced.kind === 'error')
      return { kind: 'error', error: `input "${key}": ${coerced.error}` };
    // A REQUIRED input that resolved to blank is absent in substance: '' coerces to a perfectly
    // valid string, so this is the last point its emptiness is visible. Optional inputs keep ''.
    // SAFETY: coerced.value originates in JSON node config, so it is a JsonValue.
    if (coerced.kind === 'value' && !(required && isBlankConfigValue(coerced.value as JsonValue)))
      return coerced;
  }

  // Nothing usable came from the config. `renderedEmpty` records that a value WAS supplied and
  // resolved to nothing, which reads differently from the key never being set at all.
  return resolveInputDefault(key, declaration, declaredType, required, configured !== undefined);
}

/** The declared default, coerced to its declared type; `omit` when there is none or it is empty. */
function resolveInputDefault(
  key: string,
  declaration: ManifestInputDeclaration,
  declaredType: CustomNodeInputType,
  required: boolean,
  renderedEmpty: boolean,
): ResolvedInput {
  const fallback = readInputDefault(declaration);
  if (!fallback.present) return { kind: 'omit', renderedEmpty };

  const coerced = coerceCustomNodeInputValue(declaredType, fallback.value);
  if (coerced.kind === 'error') {
    return { kind: 'error', error: `input "${key}" default: ${coerced.error}` };
  }
  // A blank default cannot satisfy a required input — declaring one required and defaulting it to
  // nothing is contradictory, and honouring the default would dispatch the empty value it was meant
  // to prevent. Optional inputs still receive it.
  // SAFETY: coerced.value originates in the JSON manifest default, so it is a JsonValue.
  if (coerced.kind === 'value' && !(required && isBlankConfigValue(coerced.value as JsonValue))) {
    return coerced;
  }
  return { kind: 'omit', renderedEmpty };
}

/**
 * Keep only declared script inputs, coerce them to their declared types, apply their defaults, and
 * never expose reserved projectId.
 *
 * Runs AFTER template rendering (dispatchCustomNode renders every top-level string), so a `number`
 * or `boolean` input bound to `{{previous.x}}` arrives as text and is converted back here — the
 * manifest-declared type is the authority, not the shape of the upstream value.
 *
 * A declared-required input that resolves to nothing fails the whole step rather than reaching the
 * script as undefined. All missing keys are reported together so the author fixes them in one pass.
 *
 * Returns a result rather than throwing: the call site in flow-step-executor sits outside its own
 * try/catch, so a throw would escape uncaught instead of failing the step.
 */
export function buildCustomNodeInputConfig(
  inputs: Record<string, unknown>,
  config: Record<string, unknown>,
): CustomNodeInputConfigResult {
  const entries: Array<[string, unknown]> = [];
  const missing: string[] = [];
  const renderedEmpty: string[] = [];
  // SAFETY: manifest JSON from disk — parsed here so nothing below reads an untrusted field.
  const declarations = parseManifestInputDeclarations(inputs as JsonValue);
  for (const [key, declaration] of Object.entries(declarations)) {
    if (key === RESERVED_INPUT_KEY) continue;
    const required = declaration.required === true;
    const resolved = resolveDeclaredInput(key, declaration, config, required);
    if (resolved.kind === 'error') return { ok: false, error: resolved.error };
    if (resolved.kind === 'value') {
      entries.push([key, resolved.value]);
      continue;
    }
    if (!required) continue;
    missing.push(key);
    if (resolved.renderedEmpty) renderedEmpty.push(key);
  }
  if (missing.length > 0) {
    return { ok: false, error: describeMissingRequiredInputs(missing, renderedEmpty) };
  }
  return { ok: true, config: Object.fromEntries(entries) };
}

/**
 * Failure text for required inputs that resolved to nothing, naming which ones were never set and
 * which were bound to a template that produced no value — the two need different fixes.
 */
function describeMissingRequiredInputs(missing: string[], renderedEmpty: string[]): string {
  const quoted = (keys: string[]): string => keys.map((k) => `"${k}"`).join(', ');
  const unset = missing.filter((key) => !renderedEmpty.includes(key));
  const parts: string[] = [];
  if (unset.length > 0) parts.push(`${quoted(unset)} not set`);
  if (renderedEmpty.length > 0) {
    parts.push(
      `${quoted(renderedEmpty)} resolved to an empty value — check the step it reads from`,
    );
  }
  return `is missing required ${missing.length === 1 ? 'input' : 'inputs'}: ${parts.join('; ')}`;
}

type NormalizedCustomNodeManifestFields = {
  displayName: string;
  description: string;
  version: string;
  timeout: number;
  inputs: Record<string, unknown>;
  hadDisplayName: boolean;
};

/** Apply the manifest defaults shared by on-disk discovery and agent registration. */
export function normalizeCustomNodeManifestFields(
  name: string,
  raw: Record<string, unknown>,
): NormalizedCustomNodeManifestFields {
  const hadDisplayName = typeof raw.displayName === 'string' && raw.displayName.trim().length > 0;
  return {
    displayName: hadDisplayName ? (raw.displayName as string).trim() : name,
    description: typeof raw.description === 'string' ? raw.description : '',
    version: typeof raw.version === 'string' ? raw.version : '1.0.0',
    timeout:
      typeof raw.timeout === 'number' && Number.isFinite(raw.timeout)
        ? Math.max(1, Math.min(raw.timeout, 600))
        : 60,
    inputs:
      typeof raw.inputs === 'object' && raw.inputs !== null && !Array.isArray(raw.inputs)
        ? (raw.inputs as Record<string, unknown>)
        : {},
    hadDisplayName,
  };
}

/** Resolve a lexical entrypoint path without requiring the file to exist. */
export function resolveContainedCustomNodePath(nodeRoot: string, entrypoint: string): string {
  assertRelativeEntrypoint(entrypoint);
  const root = resolve(nodeRoot);
  const candidate = resolve(root, entrypoint);
  if (candidate === root || isOutsideRoot(root, candidate)) {
    throw new Error(
      `[custom-node-runtime] entrypoint resolves outside node directory: ${entrypoint}`,
    );
  }
  return candidate;
}

/** Resolve an existing child path and reject lexical or symlink escapes from its root. */
export function resolveExistingContainedCustomNodePath(
  nodeRoot: string,
  relativePath: string,
  pathLabel: 'path' | 'entrypoint' = 'path',
): string {
  const containedPath = resolveContainedCustomNodePath(nodeRoot, relativePath);

  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(resolve(nodeRoot));
    realPath = realpathSync(containedPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[custom-node-runtime] could not resolve ${pathLabel} "${relativePath}" under "${nodeRoot}": ${detail}`,
    );
  }

  if (isOutsideRoot(realRoot, realPath)) {
    throw new Error(
      `[custom-node-runtime] ${pathLabel} resolves outside node directory: ${relativePath}`,
    );
  }

  return realPath;
}

/** Resolve an existing entrypoint and reject lexical or symlink escapes from the node root. */
export function resolveCustomNodeEntrypoint(nodeRoot: string, entrypoint: string): string {
  return resolveExistingContainedCustomNodePath(nodeRoot, entrypoint, 'entrypoint');
}
