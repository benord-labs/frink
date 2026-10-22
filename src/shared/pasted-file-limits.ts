/** Largest file a composer or phone attachment may copy into a chat's `pasted/` folder (20MB). */
export const PASTED_FILE_MAX_BYTES = 20 * 1024 * 1024;

export const PASTED_FILE_TOO_LARGE = `Attachments must be ${PASTED_FILE_MAX_BYTES / (1024 * 1024)} MB or smaller.`;
