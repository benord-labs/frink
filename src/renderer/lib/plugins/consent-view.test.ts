import { describe, expect, it } from 'vitest';
import {
  activeConsentUrl,
  CONSENT_IDLE,
  consentDialogOpen,
  consentViewReducer,
} from './consent-view';

const SIGN_IN = 'https://mcp.notion.com/authorize?state=abc';
const run = (...events: Parameters<typeof consentViewReducer>[1][]) =>
  events.reduce(consentViewReducer, CONSENT_IDLE);

describe('consent dialog view', () => {
  it('opens with the attempt and shows the sign-in page once main reports it', () => {
    expect(consentDialogOpen(CONSENT_IDLE, false)).toBe(false);
    const started = run({ type: 'started' });
    expect(consentDialogOpen(started, true)).toBe(true);
    const shown = consentViewReducer(started, { type: 'page', url: SIGN_IN });
    expect(shown.url).toBe(SIGN_IN);
    // The same page again is the same view, so React skips the render.
    expect(consentViewReducer(shown, { type: 'page', url: SIGN_IN })).toBe(shown);
  });

  it('keeps a failure until dismissed', () => {
    const failed = run(
      { type: 'started' },
      { type: 'page', url: SIGN_IN },
      { type: 'failed', error: 'Authorization cancelled.' },
    );
    expect(failed).toEqual({ url: SIGN_IN, error: 'Authorization cancelled.', dismissed: false });
    expect(consentDialogOpen(failed, false)).toBe(true);
    const closed = consentViewReducer(failed, { type: 'dismissed' });
    expect(consentDialogOpen(closed, false)).toBe(false);
  });

  it('reopens for a failure that lands after the user closed the dialog mid-flight', () => {
    const closed = run({ type: 'started' }, { type: 'dismissed' });
    expect(consentDialogOpen(closed, true)).toBe(false);
    const failed = consentViewReducer(closed, {
      type: 'failed',
      error: 'Authorization cancelled.',
    });
    expect(consentDialogOpen(failed, false)).toBe(true);
  });

  it('never reports an empty failure as a live attempt', () => {
    expect(run({ type: 'failed', error: '' }).error).toBe('Chat tools were not connected.');
  });

  it('finds the live page behind a sibling server that is only awaiting', () => {
    const rows = [
      { pluginName: 'acme' },
      { pluginName: 'other', consentUrl: 'https://other.test/auth' },
      { pluginName: 'acme', consentUrl: SIGN_IN },
    ];
    expect(activeConsentUrl(rows, 'acme')).toBe(SIGN_IN);
    expect(activeConsentUrl(rows, 'nobody')).toBeNull();
  });

  it('starts a new attempt clean, dropping the previous page and dismissal', () => {
    const again = run(
      { type: 'page', url: SIGN_IN },
      { type: 'failed', error: 'x' },
      { type: 'dismissed' },
      { type: 'started' },
    );
    expect(again).toEqual(CONSENT_IDLE);
    expect(consentDialogOpen(again, true)).toBe(true);
  });
});
