/**
 * Canonical (deterministic) JSON stringify.
 *
 * - Object keys sorted alphabetically (so `{a:1,b:2}` and `{b:2,a:1}` serialize identically).
 * - Arrays kept in source order (positional semantics — element order is meaningful).
 * - `undefined` values stripped (matches `JSON.stringify`'s native behaviour — `{x: undefined}`
 *   and `{}` serialize equal).
 * - `null` stringified as `"null"` so equality-by-string is consistent with `JSON.stringify`.
 *
 * Used by:
 * - `validate-flow-graph.ts` (`flowGraphsEqual`) — content-equality on flow graphs.
 * - `skills/skill-provisioner.ts` (`baselinesEqual`, `dropRejectedCopy` hash) — manifest
 *   equality + hash for rejected-drop naming.
 *
 * picks it up verbatim via `bun run sync:shared`.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
  return `{${entries.join(',')}}`;
}
