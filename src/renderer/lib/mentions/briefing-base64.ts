/**
 * Encode text to base64 for use in briefing mention tokens.
 *
 * UTF-8 bytes via TextEncoder, then standard base64. Matches
 * `Buffer.from(text, 'utf-8').toString('base64')` on the Node.js side.
 */
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function utf8BytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function encodeForMentionToken(text: string): string {
  return utf8BytesToBase64(utf8Encoder.encode(text));
}

/**
 * Decode base64 from a briefing mention token back to the original text.
 *
 * Must NOT use plain atob() as the result string: atob returns the raw UTF-8
 * byte sequence interpreted as Latin-1, which garbles non-ASCII. This path
 * converts to bytes and decodes as UTF-8. Malformed base64 or invalid UTF-8
 * yields an empty string so rendering never throws.
 */
export function decodeFromMentionToken(base64: string): string {
  if (!base64) return '';
  try {
    const binString = atob(base64);
    const len = binString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binString.charCodeAt(i) & 0xff;
    }
    return utf8Decoder.decode(bytes);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: Malformed token from user content; warn for debugging without breaking UI.
    console.warn('[decodeFromMentionToken] invalid base64 or UTF-8:', error);
    return '';
  }
}
