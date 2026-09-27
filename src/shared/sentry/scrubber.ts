import { normalizeUserPath, scrubText } from './redaction';

// Duck-typed Sentry shapes — kept narrow so this file works with both
// @sentry/electron and @sentry/node without depending on either package's
// types. Frink Cloud keeps its own copy of this file and relies on the
// same SDK-agnostic surface.
type StackFrame = {
  filename?: string | null;
  abs_path?: string | null;
  module?: string | null;
};
type Stacktrace = { frames?: StackFrame[] };
type ExceptionValue = { type?: string; value?: string; stacktrace?: Stacktrace };

export type ScrubbableEvent = {
  message?: string;
  // Set instead of `message` when the text is Sentry.parameterize'd.
  logentry?: { message?: string; params?: unknown[] };
  exception?: { values?: ExceptionValue[] };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: ScrubbableBreadcrumb[];
  // Loose shape — we only delete these fields, never read them, so any
  // structural variant Sentry passes (cookies-as-string, cookies-as-record,
  // etc.) is fine.
  request?: { headers?: unknown; data?: unknown; cookies?: unknown };
};

export type ScrubbableBreadcrumb = {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  level?: string;
  type?: string;
};

// Paths that handle prompts, file contents, raw shell output, Claude SDK
// transcripts, or credentials. Any event whose stack trace touches these is
// dropped wholesale — we cannot prove the exception value is free of user
// content or secrets, and prevention-at-source is stronger than regex theatre.
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /src\/main\/lib\/claude\//,
  /src\/main\/lib\/socket\/executor\.ts/,
  /src\/main\/lib\/terminal\//,
  /src\/main\/lib\/credentials\.ts/,
  /\.frink\/logs\/claude\//,
  // MCP OAuth token exchange (src/main/lib/oauth.ts): an error mid-exchange can
  // carry a plaintext access_token or refresh_token in its value.
  /\/oauth\.[tj]s\b/,
];

const ALLOWED_BREADCRUMB_CATEGORIES = new Set(['navigation', 'ipc', 'ui.click', 'error', 'trpc']);

function isSensitivePath(path?: string | null): boolean {
  if (!path) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
}

function eventTouchesSensitivePath(event: ScrubbableEvent): boolean {
  const exceptions = event.exception?.values ?? [];
  for (const exc of exceptions) {
    const frames = exc.stacktrace?.frames ?? [];
    for (const frame of frames) {
      if (isSensitivePath(frame.filename) || isSensitivePath(frame.abs_path)) {
        return true;
      }
    }
  }
  return false;
}

function scrubExceptionFrames(event: ScrubbableEvent): void {
  const exceptions = event.exception?.values ?? [];
  for (const exc of exceptions) {
    // fs/shell errors quote the offending absolute path, so the value leaks
    // the username even when every frame is clean.
    if (exc.value) exc.value = scrubText(exc.value);
    const frames = exc.stacktrace?.frames ?? [];
    for (const frame of frames) {
      if (frame.filename) frame.filename = normalizeUserPath(frame.filename);
      if (frame.abs_path) frame.abs_path = normalizeUserPath(frame.abs_path);
    }
  }
}

// Params can be any value; an object may nest a path, so non-strings are
// reduced to their typeof, as breadcrumb data is.
function scrubLogEntry(logentry: NonNullable<ScrubbableEvent['logentry']>): void {
  if (logentry.message) logentry.message = scrubText(logentry.message);
  if (Array.isArray(logentry.params)) {
    logentry.params = logentry.params.map((p) => (typeof p === 'string' ? scrubText(p) : typeof p));
  }
}

export function beforeBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B | null {
  const category = breadcrumb.category ?? '';
  if (!ALLOWED_BREADCRUMB_CATEGORIES.has(category)) return null;

  if (breadcrumb.data) {
    const safeData: Record<string, string> = {};
    for (const [key, value] of Object.entries(breadcrumb.data)) {
      safeData[key] = typeof value;
    }
    breadcrumb.data = safeData;
  }
  if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);

  return breadcrumb;
}

export function beforeSend<E extends ScrubbableEvent>(event: E): E | null {
  if (eventTouchesSensitivePath(event)) return null;

  delete event.extra;
  if (event.contexts) {
    delete (event.contexts as Record<string, unknown>).state;
  }
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
  }

  if (event.message) event.message = scrubText(event.message);
  if (event.logentry) scrubLogEntry(event.logentry);
  scrubExceptionFrames(event);

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map((b) => beforeBreadcrumb(b))
      .filter((b): b is ScrubbableBreadcrumb => b !== null);
  }

  return event;
}
