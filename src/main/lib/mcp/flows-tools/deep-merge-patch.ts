import { isPlainObject } from '../../../../shared/lib/case-converter/is-transformable';

/**
 * JSON Merge Patch–style merge: objects recurse; `null` removes a key from the result.
 */
export function deepMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMergePatch(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
