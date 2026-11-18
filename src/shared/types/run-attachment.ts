export type RunAttachment = {
  url: string;
  /** An image's MIME type (sent inline), or RUN_ATTACHMENT_FILE_TYPE for a file the agent reads by path. */
  type: string;
  label?: string;
  mimeType?: string;
};

/** `type` of an attachment the agent node reads from disk instead of receiving inline. */
export const RUN_ATTACHMENT_FILE_TYPE = 'file';
/** Image types sent inline to the agent. */
export const ALLOWED_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_ATTACHMENT_URL_LENGTH = 2048;
export const MAX_ATTACHMENTS_PER_RUN = 10;
