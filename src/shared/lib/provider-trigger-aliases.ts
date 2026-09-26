/**
 * Render-time resolver for the friendly per-provider trigger aliases
 * ({@link TRIGGER_FIELD_ALIASES}). Given an aliased trigger context (after
 * `applyTriggerAliases`, so `trigger.source` + `trigger.payload` are set), it
 * attaches `trigger.<alias>` values pulled from the raw payload — e.g.
 * `trigger.story = { title, id, url }` for Shortcut — so `{{trigger.story.title}}`
 * resolves to a friendly value instead of `{{trigger.payload.actions.0.name}}`.
 *
 * Local + editor only by design: webhook flows execute on-machine (local-first),
 * so the local builder (`block-context.ts`) calls this; the cloud builder stays as
 * the plain event/payload aliaser. Missing paths are skipped (the alias renders
 * empty, never literal).
 */

import { TRIGGER_FIELD_ALIASES } from '../integrations/trigger-field-aliases';

/** Read a dotted path (array indices allowed) from a value. undefined if absent. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- walks an arbitrary untrusted payload by dotted path; neither the input nor the value found there has a knowable type.
function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const seg of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** First defined (non-null) value across one-or-more candidate paths. */
export function resolveAlias(payload: unknown, path: string | string[]): unknown {
  const paths = Array.isArray(path) ? path : [path];
  for (const p of paths) {
    const v = getByPath(payload, p);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** Set `target[a.b.c] = value`, creating intermediate plain objects. */
function setByPath(target: Record<string, unknown>, alias: string, value: unknown): void {
  const segs = alias.split('.');
  let cur = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = cur[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/**
 * Attach friendly per-provider alias values onto an aliased trigger context.
 * Mutates and returns `trigger`. No-op when the provider has no alias map or the
 * payload is missing.
 */
export function applyProviderAliases(trigger: Record<string, unknown>): Record<string, unknown> {
  // Lowercase to match the editor (which lowercases integration.provider) so a chip
  // shown in the editor always resolves at render — no provider-casing divergence.
  const provider = (typeof trigger.source === 'string' ? trigger.source : '').toLowerCase();
  const aliases = TRIGGER_FIELD_ALIASES[provider];
  const payload = trigger.payload;
  if (!aliases || payload === null || typeof payload !== 'object') return trigger;
  for (const a of aliases) {
    // Always set a DECLARED alias (empty string when this event lacks the path) so a
    // friendly variable never renders as a literal `{{...}}` — the whole point. Absent
    // ≠ broken; it's an optional field for this event.
    setByPath(trigger, a.alias, resolveAlias(payload, a.path) ?? '');
  }
  return trigger;
}
