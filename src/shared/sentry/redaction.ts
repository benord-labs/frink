const REDACTED = '[REDACTED]';

// Generic high-entropy token shape.
// Catches API keys, OAuth tokens, and most opaque-string credentials of
// 32+ chars. Specific credential shapes (ghp_*, postgres://, Bearer ...)
// are NOT redacted here — those live as server-side scrubbing rules in
// the Sentry project settings, where they're tamper-resistant.
const TOKEN_LIKE_REGEX = /\b(?:sk-|gpt-|cursor_|openai-)?[a-zA-Z0-9_-]{32,}\b/gi;

// Matches macOS, Linux, and Windows user-home prefixes. Username segments
// are PII and appear in nearly every stack frame.
const USER_HOME_REGEX = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^/\s\\]+/g;
const NORMALIZED_HOME = '/home/user';

export function redactString(input: string): string {
  if (!input) return input;
  return input.replace(TOKEN_LIKE_REGEX, REDACTED);
}

export function normalizeUserPath(input: string): string {
  if (!input) return input;
  return input.replace(USER_HOME_REGEX, NORMALIZED_HOME);
}
