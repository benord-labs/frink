/** The one ask before retrying a started non-agent step (command, request), on every surface. */
export const SIDE_EFFECTS_RETRY = {
  title: 'Retry this step?',
  warning:
    'This step was interrupted partway through. Running it again may repeat actions it already took.',
  confirmLabel: 'Retry anyway',
} as const;
