/**
 * Secure template variable rendering for flow blocks.
 *
 * Supports `{{path.to.value}}` substitution with prototype pollution guards.
 * Only `trigger`, `previous`, `loop`, and `flow` root identifiers are allowed.
 *
 * Four template roots:
 * - `trigger.*` — flow trigger context (webhook payload, schedule time, etc.)
 * - `previous.*` — immediate predecessor node outputs
 * - `loop.*` — fan_out iteration context (currentItem, currentIndex, totalCount)
 * - `flow.*` — flow-level context; `flow.briefing` contains the raw briefing text
 *
 * Three rendering variants:
 * - `renderTemplate` — plain string substitution, safe for AI instructions
 * - `renderTemplateWithinUtf8Limit` — plain substitution that stops before a byte cap
 * - `renderTemplateForShell` — context-escapes each resolved value for bare,
 *   single-quoted, or double-quoted shell positions and fails closed if output exceeds its cap.
 */

import log from 'electron-log';
import { z } from 'zod';
import {
  escapeShellValueForContext,
  shellInterpolationContextAt,
} from '../../../shared/lib/shell-template/quote-context';
import { captureMainMessage } from '../sentry/init';

/** Max template string length to prevent DoS via huge templates. */
const MAX_TEMPLATE_LENGTH = 10000;
const TEMPLATE_TEXT = z.string();

/** Max JSON length for object/array leaves; refuse resolution above this (placeholder stays literal). */
const MAX_OBJECT_SERIALIZE_LENGTH = 50_000;

/**
 * A real value that cannot become text: oversize, circular, function/symbol/bigint. Distinct from
 * `undefined` (path names nothing) — unrenderable keeps its literal, absent renders empty.
 */
const UNRENDERABLE = Symbol('unrenderable');

type ResolvedValue = string | undefined | typeof UNRENDERABLE;

/** Max total output length for shell-rendered templates (ARG_MAX / argv size guard). */
const MAX_SHELL_RENDERED_OUTPUT = 256 * 1024;
const SHELL_RENDER_LIMIT_COMMAND =
  "printf '%s\\n' 'Frink: rendered command exceeded the 256KB safety limit' >&2; exit 1";

/** Cap for a ROUTING template, well under MAX_TEMPLATE_LENGTH so rendering can never truncate one. */
const MAX_ROUTING_KEY_LENGTH = 512;

/** Max path depth to prevent excessively deep traversals. */
const MAX_PATH_DEPTH = 5;

/** Allowed root identifiers in template variables. */
const ALLOWED_ROOTS = new Set(['trigger', 'previous', 'loop', 'flow']);

/** Blocked path segments to prevent prototype pollution. */
const BLOCKED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Found value at a dot-notation path, or `undefined` when a segment is blocked, unknown or too deep. */
type PathLookup = { found: true; value: unknown } | undefined;
type PathValue = NonNullable<PathLookup>['value'];
/** The variables a flow renders against (trigger / previous / loop / flow roots). */
type TemplateScope = Parameters<typeof renderTemplateForShell>[1];

/**
 * Safely walk a dot-notation path from a context object.
 * Returns undefined if any segment is blocked or not an own property.
 */
function lookupPath(obj: TemplateScope, path: string): PathLookup {
  const segments = path.split('.');
  if (segments.length > MAX_PATH_DEPTH) return undefined;

  const root = segments[0];
  if (!root || !ALLOWED_ROOTS.has(root)) return undefined;

  let current: unknown = obj;
  for (const seg of segments) {
    const next = stepInto(current, seg);
    if (!next) return undefined;
    current = next.value;
  }
  return { found: true, value: current };
}

/** One own-property step, refusing blocked segments and non-objects. */
function stepInto(current: PathValue, seg: string): PathLookup {
  if (!seg || BLOCKED_SEGMENTS.has(seg)) return undefined;
  if (typeof current !== 'object' || current === null) return undefined;
  if (!Object.hasOwn(current, seg)) return undefined;
  // SAFETY: hasOwn just proved `seg` is an own key of this object; no copy, no traversal.
  return { found: true, value: (current as TemplateScope)[seg] };
}

/** The string form a text template splices in: scalars as text, objects as JSON, nothing for null. */
function resolvePath(obj: TemplateScope, path: string): ResolvedValue {
  const hit = lookupPath(obj, path);
  return hit ? textForm(hit.value) : undefined;
}

/** What a text render splices in: an absent path is the empty string; unrenderable stays marked. */
function renderedText(obj: TemplateScope, path: string): string | typeof UNRENDERABLE {
  return resolvePath(obj, path) ?? '';
}

function textForm(current: PathValue): ResolvedValue {
  if (current === null || current === undefined) return '';
  if (typeof current === 'string') {
    if (current.length > MAX_OBJECT_SERIALIZE_LENGTH) return UNRENDERABLE;
    return current;
  }
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  if (typeof current === 'object') {
    try {
      const json = JSON.stringify(current);
      if (json.length > MAX_OBJECT_SERIALIZE_LENGTH) return UNRENDERABLE;
      return json;
    } catch {
      return UNRENDERABLE;
    }
  }
  return UNRENDERABLE;
}

/**
 * Shared template rendering core. Clamps length, warns on truncation, applies
 * `transformResolved` to each successfully resolved value.
 */
function renderTemplateWith(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
  transformResolved: (value: string) => string,
  maxTemplateLength = MAX_TEMPLATE_LENGTH,
  maxOutputBytes?: number,
): string | undefined {
  const parsedTemplate = TEMPLATE_TEXT.safeParse(template);
  if (!parsedTemplate.success) return '';
  const truncated = parsedTemplate.data.length > maxTemplateLength;
  const clamped = truncated ? parsedTemplate.data.slice(0, maxTemplateLength) : parsedTemplate.data;
  if (truncated) {
    log.warn('[template-utils] template truncated — placeholders may be split or incomplete', {
      originalLength: parsedTemplate.data.length,
      maxLength: maxTemplateLength,
    });
  }
  const chunks: string[] = [];
  let renderedBytes = 0;
  const append = (chunk: string): boolean => {
    renderedBytes += Buffer.byteLength(chunk, 'utf8');
    if (maxOutputBytes !== undefined && renderedBytes > maxOutputBytes) return false;
    chunks.push(chunk);
    return true;
  };
  const placeholders = /\{\{([^{}]+)\}\}/g;
  let cursor = 0;
  for (let match = placeholders.exec(clamped); match; match = placeholders.exec(clamped)) {
    if (!append(clamped.slice(cursor, match.index))) return undefined;
    const path = match[1].trim();
    const resolved = renderedText(variables, path);
    if (!append(resolved === UNRENDERABLE ? `{{${path}}}` : transformResolved(resolved))) {
      return undefined;
    }
    cursor = match.index + match[0].length;
  }
  return append(clamped.slice(cursor)) ? chunks.join('') : undefined;
}

/**
 * Render a template that must parse as JSON afterwards: a placeholder inside a string literal gets the
 * JSON-escaped text, one outside gets the value as JSON (quoted string, null, number, object).
 */
export function renderTemplateForJson(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
): string {
  const clamped = TEMPLATE_TEXT.catch('').parse(template).slice(0, MAX_TEMPLATE_LENGTH);
  const placeholders = /\{\{([^{}]+)\}\}/g;
  const chunks: string[] = [];
  let cursor = 0;
  let insideString = false;
  for (let match = placeholders.exec(clamped); match; match = placeholders.exec(clamped)) {
    const literal = clamped.slice(cursor, match.index);
    insideString = insideStringAfter(literal, insideString);
    chunks.push(literal);
    const path = match[1].trim();
    const resolved = insideString ? escapedText(variables, path) : jsonValue(variables, path);
    chunks.push(resolved === undefined ? `{{${path}}}` : resolved);
    cursor = match.index + match[0].length;
  }
  chunks.push(clamped.slice(cursor));
  return chunks.join('');
}

const WHOLE_PLACEHOLDER = /^\{\{([^{}]+)\}\}$/;
export const JSON_VALUE = z.json();
type JsonValue = z.infer<typeof JSON_VALUE>;
const JSON_OBJECT = z.record(z.string(), JSON_VALUE);

/**
 * Templates inside an authored structure (a `json` input written as an object): a leaf that is exactly
 * one placeholder takes the variable's own value (as `renderTemplateForJson` outside a string literal).
 */
export function renderTemplateDeep(value: JsonValue, variables: TemplateScope): JsonValue {
  const text = TEMPLATE_TEXT.safeParse(value);
  if (text.success) {
    // Verbatim when there is nothing to render, or when `renderTemplate`'s clamp would truncate it.
    if (!text.data.includes('{{') || text.data.length > MAX_TEMPLATE_LENGTH) return text.data;
    const whole = WHOLE_PLACEHOLDER.exec(text.data);
    if (!whole) return renderTemplate(text.data, variables);
    const hit = lookupPath(variables, whole[1].trim());
    // An absent path takes the value a present `null` would here, never its own placeholder text.
    if (!hit) return null;
    const resolved = JSON_VALUE.safeParse(hit.value ?? null);
    return resolved.success && textForm(resolved.data) !== UNRENDERABLE ? resolved.data : text.data;
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplateDeep(item, variables));
  const object = JSON_OBJECT.safeParse(value);
  if (!object.success) return value;
  return Object.fromEntries(
    Object.entries(object.data).map(([key, item]) => [key, renderTemplateDeep(item, variables)]),
  );
}

/** The text form, escaped to sit inside a JSON string literal; an absent path is the empty string. */
function escapedText(variables: TemplateScope, path: string): string | undefined {
  const text = renderedText(variables, path);
  return text === UNRENDERABLE ? undefined : JSON.stringify(text).slice(1, -1);
}

/** The value as a JSON document fragment: strings quoted, null literal, objects spliced. */
function jsonValue(variables: TemplateScope, path: string): string | undefined {
  const hit = lookupPath(variables, path);
  if (!hit) return undefined;
  try {
    const json = JSON.stringify(hit.value === undefined ? null : hit.value);
    return json.length > MAX_OBJECT_SERIALIZE_LENGTH ? undefined : json;
  } catch {
    return undefined;
  }
}

/** JSON string-literal parity after `text`: every unescaped `"` toggles it. */
function insideStringAfter(text: string, inside: boolean): boolean {
  let state = inside;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && state) i += 1;
    else if (text[i] === '"') state = !state;
  }
  return state;
}

/** The first {{…}} whose resolved value fails the predicate; a non-string template has none. */
function firstPlaceholderWhere(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
  fails: (resolved: ResolvedValue, match: RegExpMatchArray) => boolean,
): string | undefined {
  for (const match of TEMPLATE_TEXT.catch('')
    .parse(template)
    .matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (fails(resolvePath(variables, match[1].trim()), match)) return match[0];
  }
  return undefined;
}

/**
 * The first placeholder naming a MISSING value, checked before a command renders. An unrenderable
 * value is not missing: it keeps its literal placeholder, as the contract above states.
 */
export function findAbsentPlaceholder(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
): string | undefined {
  return firstPlaceholderWhere(template, variables, (resolved) => resolved === undefined);
}

/**
 * findAbsentPlaceholder for a shell command. Skips a placeholder in a context the renderer cannot
 * classify: renderTemplateForShell never substitutes there, so a missing value cannot collapse it.
 */
export function findAbsentShellPlaceholder(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
): string | undefined {
  const text = TEMPLATE_TEXT.catch('').parse(template).slice(0, MAX_TEMPLATE_LENGTH);
  return firstPlaceholderWhere(
    text,
    variables,
    (resolved, match) =>
      resolved === undefined &&
      escapeShellValueForContext(
        '',
        shellInterpolationContextAt(text, match.index ?? 0, match[0].length),
      ) !== null,
  );
}

/**
 * A url placeholder that would retarget the request: missing anywhere, or blank in the path, where
 * items/{{previous.id}} collapses to items/. A blank query value stays allowed.
 */
export function findUnsafeUrlPlaceholder(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
): string | undefined {
  const text = TEMPLATE_TEXT.catch('').parse(template);
  // Mask placeholders first: a webhook key may itself contain ? or #, which is not the query boundary.
  const pathEnd = text.replace(/\{\{[^{}]+\}\}/g, (m) => ' '.repeat(m.length)).search(/[?#]/);
  const path = pathEnd === -1 ? text : text.slice(0, pathEnd);
  const blankInPath = firstPlaceholderWhere(
    path,
    variables,
    (resolved) => resolved !== UNRENDERABLE && (resolved ?? '').trim() === '',
  );
  return blankInPath ?? findAbsentPlaceholder(text, variables);
}

/** True when a placeholder is missing or unrenderable: a routing value cannot route on either. */
export function hasUnresolvedPlaceholder(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
): boolean {
  return (
    firstPlaceholderWhere(
      template,
      variables,
      (resolved) => resolved === undefined || resolved === UNRENDERABLE,
    ) !== undefined
  );
}

/**
 * Render `{{path.to.value}}`. Allowed roots only, prototype-pollution paths rejected, length-capped.
 * An ABSENT path renders empty, never its own literal text; guarantees pinned in template-utils.test.ts.
 */
export function renderTemplate(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
  maxTemplateLength = MAX_TEMPLATE_LENGTH,
): string {
  return renderTemplateWith(template, variables, (value) => value, maxTemplateLength) ?? '';
}

/**
 * Renders a ROUTING template — a value selecting WHERE work happens (a branch, a project key).
 * Blank is a failure: it silently selects a default. Both rejections named in template-utils.test.ts.
 */
export function resolveRoutingTemplate(
  raw: string,
  variables: TemplateScope,
): { ok: true; value: string } | { ok: false; reason: string } {
  // Length is an error, not a pass: beyond the cap renderTemplate TRUNCATES, which would yield a
  // different — but valid — routing value. A branch or project key is never near this long.
  if (raw.length > MAX_ROUTING_KEY_LENGTH) return { ok: false, reason: 'is too long' };
  // Stray double braces (`{{previous.branch`) or Handlebars triples (`{{{x}}}` -> `{main}`) are mistyped
  // templates that would route on their own text. Single braces are legal in a branch or project name.
  if (/\{\{\{|\}\}\}/.test(raw) || /\{\{|\}\}/.test(raw.replace(/\{\{[^{}]+\}\}/g, ''))) {
    return { ok: false, reason: 'is malformed' };
  }
  if (hasUnresolvedPlaceholder(raw, variables)) return { ok: false, reason: 'did not resolve' };
  const value = renderTemplate(raw, variables).trim();
  return value ? { ok: true, value } : { ok: false, reason: 'resolved to nothing' };
}

/** Render without ever constructing output larger than `maxOutputBytes`. */
export function renderTemplateWithinUtf8Limit(
  template: string,
  variables: Parameters<typeof resolvePath>[0],
  maxOutputBytes: number,
  maxTemplateLength = MAX_TEMPLATE_LENGTH,
): string | undefined {
  return renderTemplateWith(
    template,
    variables,
    (value) => value,
    maxTemplateLength,
    maxOutputBytes,
  );
}

/**
 * POSIX single-quote escape a resolved template value so it is safe to embed
 * in a shell command string passed to exec().
 *
 * Wraps the value in single quotes and escapes any internal single quotes as
 * `'\''`. Null bytes are stripped to prevent truncation-based bypasses.
 *
 * Empty string → `''` (two single quotes; valid shell empty argument).
 */
/**
 * Shell-safe variant of {@link renderTemplate}.
 *
 * Bare values are POSIX single-quote escaped. Values already inside confidently matched quotes
 * receive context-specific escaping; uncertain shell syntax stays literal. Total output is capped.
 *
 * Security: resolved values cannot inject shell syntax in supported interpolation contexts.
 *
 * When output would exceed {@link MAX_SHELL_RENDERED_OUTPUT}, rendering fails closed with a
 * deterministic command that reports the limit and exits non-zero; partial commands never execute.
 */
export function renderTemplateForShell(
  template: string,
  variables: Record<string, unknown>,
): string {
  if (typeof template !== 'string') return '';
  const truncated = template.length > MAX_TEMPLATE_LENGTH;
  const clamped = truncated ? template.slice(0, MAX_TEMPLATE_LENGTH) : template;
  if (truncated) {
    log.warn('[template-utils] template truncated — placeholders may be split or incomplete', {
      originalLength: template.length,
      maxLength: MAX_TEMPLATE_LENGTH,
    });
  }

  const re = /\{\{([^{}]+)\}\}/g;
  let out = '';
  let last = 0;
  let warnedCap = false;

  const warnCap = (): void => {
    if (!warnedCap) {
      log.warn(
        '[template-utils] shell render output cap reached; command replaced with safe failure',
      );
      captureMainMessage('Flow command template exceeded rendered output limit', 'warning', {
        surface: 'flow-run-command',
        reason: 'render-output-limit',
      });
      warnedCap = true;
    }
  };

  /** Appends a chunk or replaces the whole command with a safe failure when the cap is exceeded. */
  const appendCapped = (chunk: string): boolean => {
    const remaining = MAX_SHELL_RENDERED_OUTPUT - out.length;
    if (chunk.length <= remaining) {
      out += chunk;
      return false;
    }
    warnCap();
    out = SHELL_RENDER_LIMIT_COMMAND;
    return true;
  };

  let m: RegExpExecArray | null = re.exec(clamped);
  while (m !== null) {
    const match = m[0];
    const offset = m.index;
    if (appendCapped(clamped.slice(last, offset))) {
      return out;
    }
    const path = m[1].trim();
    const resolved = renderedText(variables, path);
    if (resolved === UNRENDERABLE) {
      if (appendCapped(match)) {
        return out;
      }
    } else {
      const context = shellInterpolationContextAt(clamped, offset, match.length);
      const escaped = escapeShellValueForContext(resolved, context);
      if (escaped === null) {
        // EVERY placeholder stays literal here, absent ones included: the interpolation-safety
        // Target draws its boundary on the context, not on what the path resolved to.
        log.warn('[template-utils] uncertain shell context; placeholder left literal', { path });
        if (appendCapped(match)) return out;
      } else {
        if (context === 'single' || context === 'double') {
          log.warn('[template-utils] rendering quoted placeholder with context-aware escaping', {
            path,
            context,
          });
        }
        if (appendCapped(escaped)) return out;
      }
    }
    last = offset + match.length;
    m = re.exec(clamped);
  }
  if (appendCapped(clamped.slice(last))) {
    return out;
  }
  return out;
}
