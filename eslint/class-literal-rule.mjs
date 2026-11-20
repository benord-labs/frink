/**
 * A rule that reports every match of `pattern` in a string or template literal, so a class
 * built with cn(), a ternary or a constant is caught as surely as one written inline.
 * @returns {import('eslint').Rule.RuleModule}
 */
export function classLiteralRule({ pattern, messageId, message, description }) {
  const report = (context, node, text) => {
    for (const match of text.matchAll(pattern)) {
      context.report({ node, messageId, data: { match: match[0] } });
    }
  };
  return {
    meta: {
      type: 'problem',
      docs: { description },
      messages: { [messageId]: message },
      schema: [],
    },
    create(context) {
      return {
        Literal(node) {
          report(context, node, String(node.value));
        },
        TemplateElement(node) {
          report(context, node, node.value.raw);
        },
      };
    },
  };
}
