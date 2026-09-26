import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCorruptTranscriptReportsForTests,
  _setCorruptTranscriptCaptureForTests,
  reportCorruptTranscript,
} from './transcript-corruption';

const capture = vi.fn();
const report = (rowId: string): void =>
  reportCorruptTranscript(rowId, '{not json', new SyntaxError('Unexpected token'));

beforeEach(() => {
  capture.mockReset();
  _resetCorruptTranscriptReportsForTests();
  _setCorruptTranscriptCaptureForTests(capture);
});
afterEach(() => _setCorruptTranscriptCaptureForTests(null));

describe('reportCorruptTranscript', () => {
  it('retries on the next read when the capture rejected, instead of latching', async () => {
    capture.mockRejectedValueOnce(new Error('sentry unavailable'));

    report('row-1');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    report('row-1');

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  });

  it('bounds the dedup set: rows past the cap report again rather than growing it', async () => {
    for (let i = 0; i < 256; i++) report(`row-${i}`);
    report('row-0');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(256));

    report('row-256'); // the 257th distinct row drops the set
    report('row-0');

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(258));
  });
});
