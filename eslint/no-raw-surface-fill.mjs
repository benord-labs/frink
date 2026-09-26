// A renderer surface takes the Frink Glass class for its role, never a bare bg-card or bg-popover.
// Why, and the fills it deliberately misses: docs/decisions/transparency-glass-surfaces.md.

const RAW_SURFACE_FILL_RE = /(?<![:\-\w])bg-(?:popover|card)(?![\w/-])/g;

function reportRawFills(context, node, text) {
  for (const match of text.matchAll(RAW_SURFACE_FILL_RE)) {
    context.report({ node, messageId: 'rawFill', data: { fill: match[0] } });
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawSurfaceFill = {
  meta: {
    type: 'problem',
    docs: { description: 'Surfaces use the Frink Glass classes, not a bare solid fill.' },
    messages: {
      rawFill:
        '"{{fill}}" is a solid fill that ignores Transparency. Use glass-card (panel or card), glass-float (content moves behind it), overlayGlass (overlay) or a tint such as bg-muted/30 (inside a glass surface).',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        reportRawFills(context, node, String(node.value));
      },
      TemplateElement(node) {
        reportRawFills(context, node, node.value.raw);
      },
    };
  },
};
