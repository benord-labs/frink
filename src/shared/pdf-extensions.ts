/**
 * Shared PDF extension and size limit for PDF file viewing.
 * Used by the files router (readPdfFile) and the code editor panel (PDF viewer).
 * Mirrors the pattern in src/shared/image-extensions.ts.
 */

/** Max raw file size for PDF display (20MB). Base64 IPC payload ~27MB; acceptable for typical docs. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Returns true if the path has a .pdf extension (case-insensitive).
 */
export function isPdfPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.pdf');
}
