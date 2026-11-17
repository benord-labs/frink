import { describe, expect, it } from 'vitest';
import { decodeFromMentionToken, encodeForMentionToken } from './mention-token-codec';

describe('encodeForMentionToken', () => {
  it('encodes ASCII text to standard base64', () => {
    expect(encodeForMentionToken('My Flow')).toBe('TXkgRmxvdw==');
  });

  it('produces a string decodeable by decodeFromMentionToken (ASCII round-trip)', () => {
    expect(decodeFromMentionToken(encodeForMentionToken('My Flow'))).toBe('My Flow');
  });

  it('handles empty string', () => {
    expect(encodeForMentionToken('')).toBe('');
  });

  it('encodes text with spaces and special ASCII chars', () => {
    const text = 'Spec: Use "strict" mode & <TypeScript>';
    expect(decodeFromMentionToken(encodeForMentionToken(text))).toBe(text);
  });
});

describe('decodeFromMentionToken', () => {
  it('decodes ASCII base64 correctly', () => {
    const encoded = encodeForMentionToken('Hello World');
    expect(decodeFromMentionToken(encoded)).toBe('Hello World');
  });

  it('decodes Unicode (CJK) correctly — regression: plain atob() produces garbage', () => {
    // Plain atob() reads the UTF-8 bytes as Latin-1, which garbles non-ASCII text.
    const original = '日本語テスト';
    const encoded = encodeForMentionToken(original);
    const decoded = decodeFromMentionToken(encoded);
    expect(decoded).toBe(original);

    // Verify atob alone gives the wrong result (documents why this fix is needed).
    const rawAtob = atob(encoded);
    expect(rawAtob).not.toBe(original);
  });

  it('decodes emoji correctly', () => {
    const original = 'Always ✅ ship with 🚀';
    expect(decodeFromMentionToken(encodeForMentionToken(original))).toBe(original);
  });

  it('decodes multiline markdown correctly', () => {
    const text = '# Spec\n\nAlways use TypeScript.\n- Step 1\n- Step 2';
    expect(decodeFromMentionToken(encodeForMentionToken(text))).toBe(text);
  });

  it('decodes Arabic script correctly', () => {
    const original = 'مواصفات المشروع';
    expect(decodeFromMentionToken(encodeForMentionToken(original))).toBe(original);
  });

  it('returns empty string for empty input', () => {
    expect(decodeFromMentionToken('')).toBe('');
  });

  it('returns empty string for malformed base64 without throwing', () => {
    expect(decodeFromMentionToken('not-valid!!!')).toBe('');
  });

  it('returns empty string for well-formed base64 whose bytes are invalid UTF-8 (fatal decode)', () => {
    // Single 0xff is not valid UTF-8; TextDecoder with fatal:true throws — must not propagate.
    const invalidUtf8Bytes = btoa(String.fromCharCode(0xff));
    expect(decodeFromMentionToken(invalidUtf8Bytes)).toBe('');
  });
});
