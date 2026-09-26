/**
 * Deterministic workstream-name → color palette mapping for the BatchPlanCanvas.
 *
 * Uses a simple string hash to map workstream names to a fixed palette of
 * distinguishable HSL colors that render legibly in dark mode.
 *
 * Design note: palette is intentionally < palette size so cycling is rare in
 * typical CEO DAG batches (3-8 workstreams). If count exceeds palette length,
 * colors wrap (two workstreams share a color) — this is preferable to a more
 * complex scheme for the uncommon case.
 */

/**
 * 10 distinct HSL colors chosen for legibility on dark backgrounds and
 * sufficient contrast for colorblind users when combined with text abbreviations.
 */
export const WORKSTREAM_COLOR_PALETTE: string[] = [
  'hsl(210, 80%, 60%)', // blue
  'hsl(145, 60%, 50%)', // green
  'hsl(35, 90%, 58%)', // amber
  'hsl(280, 65%, 65%)', // purple
  'hsl(0, 70%, 62%)', // red
  'hsl(175, 55%, 48%)', // teal
  'hsl(320, 60%, 62%)', // pink
  'hsl(55, 80%, 52%)', // yellow
  'hsl(190, 70%, 52%)', // cyan
  'hsl(15, 75%, 58%)', // orange
];

/**
 * Deterministic string hash (djb2) that maps a workstream name to a palette index.
 * Returns a stable index for the same input across calls and environments.
 */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep as unsigned 32-bit
  }
  return h;
}

/**
 * Returns a deterministic HSL color string for a workstream name.
 * The same name always maps to the same color within a render session.
 */
export function getWorkstreamColor(workstreamId: string): string {
  const idx = hashString(workstreamId) % WORKSTREAM_COLOR_PALETTE.length;
  return WORKSTREAM_COLOR_PALETTE[idx] as string;
}

/**
 * Returns a 2-character uppercase abbreviation for a workstream name,
 * used as a WCAG-compliant secondary signal alongside color.
 *
 * Examples: "auth-module" → "AU", "ui-work" → "UI", "api" → "AP"
 */
export function getWorkstreamAbbrev(workstreamId: string): string {
  const clean = workstreamId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return clean.slice(0, 2) || '??';
}
