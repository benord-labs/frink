import * as Sentry from '@sentry/electron/main';
import type { ErrorEvent } from '@sentry/electron/main';
import { app } from 'electron';
import log from 'electron-log';
import {
  type DiagnosticContext,
  sanitizeDiagnosticContext,
} from '../../../shared/sentry/diagnostic-context';
import { beforeBreadcrumb, beforeSend } from '../../../shared/sentry/scrubber';
import { IS_DEV } from '../../constants';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  if (IS_DEV || !app.isPackaged) {
    log.info('[sentry] skipped — dev or unpackaged');
    return;
  }

  const dsn = import.meta.env.MAIN_VITE_SENTRY_DSN;
  if (!dsn) {
    log.warn('[sentry] skipped — MAIN_VITE_SENTRY_DSN is not set');
    return;
  }

  try {
    Sentry.init({
      dsn,
      release: app.getVersion(),
      defaultIntegrations: false,
      integrations: [
        Sentry.sentryMinidumpIntegration(),
        Sentry.electronContextIntegration(),
        Sentry.electronBreadcrumbsIntegration(),
        Sentry.childProcessIntegration(),
        Sentry.onUncaughtExceptionIntegration(),
        Sentry.onUnhandledRejectionIntegration(),
        Sentry.additionalContextIntegration(),
      ],
      beforeSend: (event) => {
        const scrubbed = beforeSend(event);
        return scrubbed && tagNativeOomEvent(scrubbed);
      },
      beforeBreadcrumb: (breadcrumb) => beforeBreadcrumb(breadcrumb),
    });
    initialized = true;
    log.info('[sentry] init succeeded', { release: app.getVersion() });
  } catch (err) {
    // Sentry init must never crash the app boot, but the failure must be loud.
    log.error('[sentry] init failed', err);
  }
}

export function isSentryInitialized(): boolean {
  return initialized;
}

const OOM_ANNOTATION_KEYS = [
  'crashpad.page-allocator-mapped-size',
  'crashpad.electron.v8-oom.location',
];
const RENDERER_ANNOTATION_KEYS = ['crashpad.process_type', 'crashpad.ptype'];

/**
 * Sentry copies every Crashpad annotation of a native crash onto `contexts.electron`; a renderer's
 * OOM crash key there is the same evidence the dev-only local capture reads from the dump.
 */
export function tagNativeOomEvent(event: ErrorEvent): ErrorEvent {
  if (event.platform !== 'native') return event;
  const electron = event.contexts?.electron ?? {};
  if (!RENDERER_ANNOTATION_KEYS.some((key) => electron[key] === 'renderer')) return event;
  if (!OOM_ANNOTATION_KEYS.some((key) => key in electron)) return event;
  return { ...event, tags: { ...event.tags, oom: 'confirmed', oom_evidence: 'crashpad_oom_key' } };
}

export function captureMainException(error: unknown, tags?: Record<string, string>): void {
  if (!initialized) return;
  try {
    Sentry.captureException(error, tags ? { tags } : undefined);
  } catch {
    // Never let Sentry capture errors propagate
  }
}

/** @param fingerprint Stable grouping key; without one Sentry groups by the message text. */
export function captureMainMessage(
  message: string,
  level: 'fatal' | 'error' | 'warning' = 'error',
  tags?: Record<string, string>,
  fingerprint?: string[],
): void {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      if (fingerprint) scope.setFingerprint(fingerprint);
      Sentry.captureMessage(message, { level, tags });
    });
  } catch {
    // Never let Sentry capture errors propagate
  }
}

/**
 * Updates the scope cached by the existing native-minidump integration. This
 * PR adds scalar context only; native minidump upload remains unchanged.
 */
export function setMainDiagnosticContext(context: DiagnosticContext): void {
  if (!initialized) return;
  const safe = sanitizeDiagnosticContext(context);
  if (!safe) return;
  try {
    Sentry.setContext('frink_runtime', safe);
  } catch {
    // Never let diagnostic context propagation affect the app.
  }
}

/** Captures one diagnostic with an isolated prior/current runtime snapshot. */
export function captureMainDiagnosticMessage(
  message: string,
  level: 'fatal' | 'error' | 'warning',
  tags: Record<string, string>,
  context?: DiagnosticContext,
): void {
  if (!initialized) return;
  const safe = context ? sanitizeDiagnosticContext(context) : null;
  try {
    Sentry.withScope((scope) => {
      // A previous-session incident without a persisted snapshot must not inherit the current
      // session's global runtime context from the forked scope.
      scope.setContext('frink_runtime', safe);
      Sentry.captureMessage(message, { level, tags });
    });
  } catch {
    // Never let Sentry capture errors propagate.
  }
}
