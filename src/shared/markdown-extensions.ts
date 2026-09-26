/**
 * Markdown file extensions for the code editor (Monaco language + preview).
 * Keep in sync with extension→language mapping in code-editor atoms.
 */

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

/**
 * Returns true if the path ends with .md or .mdx (case-insensitive).
 */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  const lastDot = lower.lastIndexOf('.');
  if (lastDot === -1) return false;
  const ext = lower.slice(lastDot);
  return MARKDOWN_EXTENSIONS.has(ext);
}
