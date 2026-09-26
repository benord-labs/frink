/**
 * Shared image extension and MIME definitions for image file viewing.
 * Used by the files router (readImageFile) and the code editor panel (image viewer).
 */

/**
 * MIME type by extension (lowercase, with leading dot).
 * SVG is deliberately absent so users can edit .svg as code in Monaco.
 */
const IMAGE_EXTENSION_MIME = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
]);

/**
 * Returns MIME type for the path, or undefined if not an image path.
 */
export function getImageMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  const lastDot = lower.lastIndexOf('.');
  if (lastDot === -1) return undefined;
  return IMAGE_EXTENSION_MIME.get(lower.slice(lastDot));
}

/**
 * Returns true if the path has an allowed image extension (case-insensitive).
 */
export function isImagePath(path: string): boolean {
  return getImageMimeType(path) !== undefined;
}
