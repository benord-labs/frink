// A renderer surface takes the Frink Glass class for its role, never a bare bg-card or bg-popover.
// Why, and the fills it deliberately misses: docs/decisions/transparency-glass-surfaces.md.
import { classLiteralRule } from './class-literal-rule.mjs';

export const noRawSurfaceFill = classLiteralRule({
  pattern: /(?<![:\-\w])bg-(?:popover|card)(?![\w/-])/g,
  messageId: 'rawFill',
  description: 'Surfaces use the Frink Glass classes, not a bare solid fill.',
  message:
    '"{{match}}" is a solid fill that ignores Transparency. Use glass-card (panel or card), glass-float (content moves behind it), overlayGlass (overlay) or a tint such as bg-muted/30 (inside a glass surface).',
});
