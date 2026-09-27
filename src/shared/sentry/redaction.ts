const REDACTED = '[REDACTED]';

// Generic high-entropy token shape.
// Catches API keys, OAuth tokens, and most opaque-string credentials of
// 32+ chars. Specific credential shapes (ghp_*, postgres://, Bearer ...)
// are NOT redacted here — those live as server-side scrubbing rules in
// the Sentry project settings, where they're tamper-resistant.
const TOKEN_LIKE_REGEX = /\b(?:sk-|gpt-|cursor_|openai-)?[a-zA-Z0-9_-]{32,}\b/gi;

// macOS, Linux and Windows (any drive case, JSON-escaped) home prefixes; the username is PII.
// A Windows folder spans spaces only when a backslash or a closing delimiter ends it.
const USER_HOME_REGEX =
  /(?:\/Users\/|\/home\/)[^/\\\s'"`:;,()<>|]+|[A-Za-z]:\\+Users\\+(?:[^\\/:*?"<>|\r\n]+(?=\\)|[^\\/:*?"<>|\r\n]+?(?=['"`),\]](?:\W|$))|[^/\\\s'"`:;,()<>|]+)/g;
const NORMALIZED_HOME = '/home/user';

export function redactString(input: string): string {
  if (!input) return input;
  return input.replace(TOKEN_LIKE_REGEX, REDACTED);
}

export function normalizeUserPath(input: string): string {
  if (!input) return input;
  return input.replace(USER_HOME_REGEX, NORMALIZED_HOME);
}

// Single entry point for free-text Sentry fields (messages, exception values,
// breadcrumbs), so no field can be scrubbed with less than the others.
export function scrubText(input: string): string {
  return normalizeUserPath(redactString(input));
}
