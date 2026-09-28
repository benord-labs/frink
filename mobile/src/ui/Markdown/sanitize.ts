import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

export function safeWebLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function plainText(node: Nodes): string {
  if ('children' in node) return node.children.map(plainText).join('');
  if ('value' in node) return node.value;
  if ('alt' in node) return node.alt ?? '';
  return '';
}

function escapeText(value: string) {
  return value.replace(/[\\`*_{}[\]()<>#!|~]/g, '\\$&');
}

// The text that replaces an image, raw HTML or an unsafe link; undefined keeps the node.
// Reason: Each unsafe Markdown node kind is one explicit, unit-tested branch.
// fallow-ignore-next-line complexity
function unsafeReplacement(node: Nodes, definitions: Map<string, string>): string | undefined {
  if (node.type === 'image' || node.type === 'imageReference')
    return escapeText(node.alt ? `Image: ${node.alt} (not loaded)` : 'Image not loaded.');
  if (node.type === 'html') return '';
  const target =
    node.type === 'link'
      ? node.url
      : node.type === 'linkReference'
        ? (definitions.get(node.identifier.toUpperCase()) ?? '')
        : undefined;
  return target !== undefined && !safeWebLink(target) ? escapeText(plainText(node)) : undefined;
}

// Parse with CommonMark's AST so images in fenced code are preserved and nested/reference
// syntax cannot bypass the no-network-media rule. Native Markdown receives only safe content.
export function sanitizeMarkdown(markdown: string): string {
  const tree = fromMarkdown(markdown);
  const definitions = new Map(
    tree.children
      .filter((node) => node.type === 'definition')
      .map((node) => [node.identifier.toUpperCase(), node.url]),
  );
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  function visit(node: Nodes) {
    const replacement = unsafeReplacement(node, definitions);
    if (replacement !== undefined && node.position) {
      replacements.push({
        start: node.position.start.offset!,
        end: node.position.end.offset!,
        text: replacement,
      });
      return;
    }
    if ('children' in node) node.children.forEach(visit);
  }
  visit(tree);
  return replacements
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), markdown);
}
