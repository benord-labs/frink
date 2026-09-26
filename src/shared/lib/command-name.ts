/**
 * Shared command-name validation regex.
 *
 * Alphanumeric, hyphens, underscores, and colons (namespace separator).
 * Colons cannot appear at the start/end or consecutively.
 *
 * Used by both the backend router and the frontend editor modal.
 */
export const VALID_COMMAND_NAME = /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/;
