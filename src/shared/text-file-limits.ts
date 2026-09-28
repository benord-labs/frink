/**
 * Size limit for loading a file into the code editor as text.
 * Used by the files router (readFile). Mirrors src/shared/pdf-extensions.ts.
 */

/** Max raw file size the code editor will load as text (10MB). */
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
