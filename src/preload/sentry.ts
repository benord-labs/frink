type PreloadSentrySdk = Pick<typeof import('@sentry/electron/renderer'), 'init'>;

// Preload's isolated world needs its own init; events reach Sentry through the main process.
// Production only: in dev there is no main-process Sentry to receive them.
export async function initPreloadSentry(
  loadSdk: () => Promise<PreloadSentrySdk> = () => import('@sentry/electron/renderer'),
): Promise<void> {
  const dsn = import.meta.env.MAIN_VITE_SENTRY_DSN;
  if (!import.meta.env.PROD || !dsn) return;
  const [Sentry, { beforeBreadcrumb, beforeSend }] = await Promise.all([
    loadSdk(),
    import('../shared/sentry/scrubber'),
  ]);
  Sentry.init({
    dsn,
    defaultIntegrations: false,
    beforeSend: (event) => beforeSend(event),
    beforeBreadcrumb: (breadcrumb) => beforeBreadcrumb(breadcrumb),
  });
}
