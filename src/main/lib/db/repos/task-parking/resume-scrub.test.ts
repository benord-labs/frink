import { describe, expect, it } from 'vitest';
import { RESUME_STALE_RESULT_KEYS, scrubResumedResult } from './resume-scrub';

describe('scrubResumedResult', () => {
  it('clears every per-attempt marker and preserves linkage + caller fields', () => {
    // A user-paused flow that was reload/crash-cancelled: the cancel MERGED its marker onto the
    // result, so the ended attempt's markers all survive into what the resume reads.
    const parked = {
      subChatId: 'sc-1',
      startMode: 'plan',
      chatId: 'c-1',
      userPause: { at: '2026-07-14T00:00:00Z' },
      apiError: { status: 500 },
      agentSignal: { state: 'awaiting_input', summary: 'stale ask' },
      cancelled: true,
      error: 'Interrupted by an app restart',
    };

    const resumed = scrubResumedResult(parked);

    expect(resumed).toEqual({ subChatId: 'sc-1', startMode: 'plan', chatId: 'c-1' });
    // Input untouched — callers spread the previous result elsewhere too.
    expect(parked.userPause).toBeDefined();
  });

  it('covers the full marker vocabulary — a key added to one resume path cannot silently miss here', () => {
    const everyMarker = Object.fromEntries(RESUME_STALE_RESULT_KEYS.map((k) => [k, 'stale']));
    expect(scrubResumedResult({ ...everyMarker, subChatId: 'sc-1' })).toEqual({
      subChatId: 'sc-1',
    });
  });
});
