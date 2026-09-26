/**
 * Limits for `http_request` flow block persisted config + runtime checks.
 * Keep numeric values in sync with `src/main/lib/flows/http-request-url-guard.ts`.
 */

export const HTTP_REQUEST_MAX_URL_LENGTH = 2048;
export const HTTP_REQUEST_MAX_BODY_UTF8_BYTES = 1_000_000;
export const HTTP_REQUEST_MAX_HEADERS_JSON_BYTES = 8192;
