/** What the connect dialog shows for a browser consent: the sign-in page main opened, the failure, and whether the user closed it. */
export type ConsentView = { url: string | null; error: string | null; dismissed: boolean };

export const CONSENT_IDLE: ConsentView = { url: null, error: null, dismissed: false };

export type ConsentEvent =
  | { type: 'started' }
  | { type: 'page'; url: string }
  | { type: 'failed'; error: string }
  | { type: 'dismissed' };

/** A new attempt starts clean: main mints a fresh sign-in page per attempt, so the old one is never shown stale. */
export function consentViewReducer(view: ConsentView, event: ConsentEvent): ConsentView {
  switch (event.type) {
    case 'started':
      return CONSENT_IDLE;
    case 'page':
      return view.url === event.url ? view : { ...view, url: event.url };
    case 'failed':
      // A failure reopens a dialog the user closed mid-flight: closing hides the wait, never the result.
      return { ...view, error: event.error || 'Chat tools were not connected.', dismissed: false };
    case 'dismissed':
      return { ...view, error: null, dismissed: true };
  }
}

/** The live sign-in page among a plugin's servers: siblings that are merely awaiting carry none. */
export function activeConsentUrl(
  rows: readonly { pluginName: string; consentUrl?: string }[],
  pluginName: string,
): string | null {
  return rows.find((row) => row.pluginName === pluginName && row.consentUrl)?.consentUrl ?? null;
}

/** Open while the consent runs or a failure is unread, until the user closes it. */
export function consentDialogOpen(view: ConsentView, running: boolean): boolean {
  return !view.dismissed && (running || view.error !== null);
}
