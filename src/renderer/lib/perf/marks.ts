/** Dev-only DevTools timeline marker; `scripts/perf/perf-trace.mjs --history` lists these beside
 * the browser's buffered slow frames so a drop reads against app activity. */
type MarkValue = string | number | boolean | null | undefined;

export function perfMark(name: string, properties: Record<string, MarkValue> = {}): void {
  if (!import.meta.env.DEV) return;
  performance.mark(name, {
    detail: {
      devtools: {
        dataType: 'marker',
        properties: Object.entries(properties).map(([key, value]) => [key, String(value ?? '')]),
      },
    },
  });
}
