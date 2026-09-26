import { describe, expect, it } from 'vitest';
import { getSerializedMentionScanLastIndex } from '@/lib/mentions/serialized-mention-scan-index';

describe('getSerializedMentionScanLastIndex', () => {
  it('returns 0 when there are no mentions', () => {
    expect(getSerializedMentionScanLastIndex('plain only')).toBe(0);
  });

  it('returns exclusive end offset after a single mention (tail must not duplicate full string)', () => {
    const s = 'x @[a] tail';
    expect(getSerializedMentionScanLastIndex(s)).toBe(s.indexOf(']') + 1);
    expect(s.slice(getSerializedMentionScanLastIndex(s))).toBe(' tail');
  });

  it('returns offset after the last mention when multiple tokens exist', () => {
    const s = 'a @[x] b @[y] z';
    const lastIdx = getSerializedMentionScanLastIndex(s);
    expect(lastIdx).toBe(s.lastIndexOf(']') + 1);
    expect(s.slice(lastIdx)).toBe(' z');
  });
});
