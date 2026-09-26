export type RunAttachment = {
  url: string;
  /** Free-form type string. For hosted images use the MIME type (e.g. 'image/png', 'image/webp') or 'image'. */
  type: string;
  label?: string;
  mimeType?: string;
};

export const ALLOWED_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_ATTACHMENT_URL_LENGTH = 2048;
export const MAX_ATTACHMENTS_PER_RUN = 10;
