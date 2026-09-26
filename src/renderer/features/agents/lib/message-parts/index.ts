import type { UIMessage } from 'ai';

/**
 * Extract text content from a UIMessage
 */
export function extractText(message: UIMessage | undefined): string {
  if (!message) return '';

  const parts = message.parts || [];
  const textParts = parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text);

  return textParts.join('\n');
}

/** Image payload for building message parts (base64 + MIME type) */
export type ExtractedImage = {
  data: string;
  mimeType: string;
  filename?: string;
};

/** An image part ready for the userMessage — inline base64 */
export type ResolvedImagePart = {
  mimeType: string;
  data: string;
};

/**
 * Extract base64 images from a UIMessage.
 * Handles both SDK-style parts (type 'file' with mimeType + data) and UI-style
 * parts (type 'data-image' with data.base64Data + data.mediaType) so images
 * are sent to the agent and persisted to Neon.
 */
export function extractImages(message: UIMessage | undefined): ExtractedImage[] {
  if (!message) return [];

  const parts = message.parts || [];
  const images: ExtractedImage[] = [];

  for (const part of parts) {
    if (part.type === 'file' && 'mimeType' in part && 'data' in part) {
      const mimeType = part.mimeType as string;
      const data = part.data as string;
      if (mimeType?.startsWith('image/') && data) {
        images.push({ data, mimeType });
      }
    } else if (part.type === 'data-image' && part.data && typeof part.data === 'object') {
      const d = part.data as { base64Data?: string; mediaType?: string; filename?: string };
      const data = d.base64Data;
      const mimeType = d.mediaType || 'image/png';
      if (data && mimeType.startsWith('image/')) {
        images.push({ data, mimeType, filename: d.filename });
      }
    }
  }

  return images;
}
