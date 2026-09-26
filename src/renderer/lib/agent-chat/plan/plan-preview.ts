// Collapsed plan headers show a single truncated line where block markdown can't render — strip the
// common inline/heading markers so users don't see raw `##`/`**`/backtick literals in the chip.
export function toPlainPreview(md: string): string {
  return md
    .replace(/`+/g, '')
    .replace(/\*\*?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
