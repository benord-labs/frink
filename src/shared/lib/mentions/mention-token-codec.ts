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

/** Base64 of the UTF-8 bytes of `text`, for the payload of a mention token.
 * Equal to `Buffer.from(text, 'utf-8').toString('base64')` in Node. */
export function encodeForMentionToken(text: string): string {
  return utf8BytesToBase64(utf8Encoder.encode(text));
}

/** The text a mention token payload encodes; empty when the base64 or its UTF-8 is malformed.
 * Decodes the bytes as UTF-8: `atob` alone reads them as Latin-1 and garbles non-ASCII text. */
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
    // Malformed token from user content: warn for debugging without breaking the UI.
    console.warn('[decodeFromMentionToken] invalid base64 or UTF-8:', error);
    return '';
  }
}
