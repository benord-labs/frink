/**
 * Parses stdout from custom node --list-options into select options.
 * Duplicate `value` entries keep the first occurrence (stable React keys).
 */

type DynamicSelectOption = {
  name: string;
  value: string;
};

/** Returns [] for invalid JSON, wrong shape, or missing stdout. */
export function parseDynamicSelectOptionsFromStdout(
  stdout: string | undefined,
): DynamicSelectOption[] {
  if (!stdout) return [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).name === 'string' &&
          typeof (item as Record<string, unknown>).value === 'string',
      )
    ) {
      return [];
    }
    const raw = parsed as DynamicSelectOption[];
    const seen = new Set<string>();
    const deduped: DynamicSelectOption[] = [];
    for (const opt of raw) {
      if (seen.has(opt.value)) continue;
      seen.add(opt.value);
      deduped.push(opt);
    }
    return deduped;
  } catch {
    return [];
  }
}
