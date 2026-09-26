import * as Sentry from '@sentry/electron/renderer';
import { beforeBreadcrumb, beforeSend } from '../../../shared/sentry/scrubber';

// Production only: in dev the renderer SDK's IPC has no main-process Sentry to reach.
// The DSN is bundled at build time; Sentry DSNs are public by design.
if (import.meta.env.PROD && import.meta.env.RENDERER_VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.RENDERER_VITE_SENTRY_DSN,
    defaultIntegrations: false,
    beforeSend: (event) => beforeSend(event),
    beforeBreadcrumb: (breadcrumb) => beforeBreadcrumb(breadcrumb),
  });
}
