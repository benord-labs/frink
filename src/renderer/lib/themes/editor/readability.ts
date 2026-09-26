import { contrastRatio } from '../palette/color';
import type { Palette, Role } from '../palette/roles';

// WCAG AA for text. derive.ts solves to 4.6 for headroom; a warning should only claim a real miss.
const AA = 4.5;

// Each text colour and the surfaces it is read on: the pairs derivePalette solves.
const READS_ON = new Map<Role, readonly Role[]>([
  ['text', ['background', 'surface', 'sidebar', 'overlay']],
  ['mutedText', ['background', 'muted', 'highlightSurface']],
  ['subtleForeground', ['subtleSurface']],
  ['highlightForeground', ['highlightSurface']],
  ['accentForeground', ['accent']],
  ['destructive', ['background', 'overlay']],
  ['destructiveForeground', ['destructive']],
]);

/** Whether `role` falls below AA on any surface it is read on. Lines and fills never do. */
export function isHardToRead(palette: Palette, role: Role): boolean {
  return (READS_ON.get(role) ?? []).some(
    (surface) => contrastRatio(palette[role], palette[surface]) < AA,
  );
}
