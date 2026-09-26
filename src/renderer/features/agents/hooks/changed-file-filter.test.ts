import { describe, expect, it } from 'vitest';
import { shouldSkipChangedFilePart } from './changed-file-filter';

describe('shouldSkipChangedFilePart', () => {
  it('skips permission-denied writes', () => {
    expect(
      shouldSkipChangedFilePart({
        type: 'tool-Write',
        output: { permissionDenied: true },
      }),
    ).toBe(true);
  });

  it('skips failed edits', () => {
    expect(
      shouldSkipChangedFilePart({
        type: 'tool-Edit',
        output: { success: false },
      }),
    ).toBe(true);
  });

  it('skips output-error state', () => {
    expect(
      shouldSkipChangedFilePart({
        type: 'tool-Edit',
        state: 'output-error',
      }),
    ).toBe(true);
  });

  it('keeps successful writes', () => {
    expect(
      shouldSkipChangedFilePart({
        type: 'tool-Write',
        state: 'output-available',
        output: { success: true },
      }),
    ).toBe(false);
  });

  it('keeps successful tool-Edit parts', () => {
    expect(
      shouldSkipChangedFilePart({
        type: 'tool-Edit',
        state: 'output-available',
        output: { success: true },
      }),
    ).toBe(false);
  });

  it('does not skip minimal or unknown tool parts without failure signals', () => {
    expect(shouldSkipChangedFilePart({} as Parameters<typeof shouldSkipChangedFilePart>[0])).toBe(
      false,
    );
    expect(shouldSkipChangedFilePart({ type: 'tool-Write' })).toBe(false);
    expect(shouldSkipChangedFilePart({ type: 'tool-Unknown' })).toBe(false);
  });
});
