/** Image types recognised from a file's first bytes, so a declared type is never trusted. Each
 *  signature is checked whole: a text file can start with a few of its bytes. */
const IMAGE_SIGNATURES: Array<{ mimeType: string; bytes: Array<[offset: number, ascii: string]> }> =
  [
    { mimeType: 'image/png', bytes: [[0, '\x89PNG\r\n\x1a\n']] },
    { mimeType: 'image/jpeg', bytes: [[0, '\xff\xd8\xff']] },
    { mimeType: 'image/gif', bytes: [[0, 'GIF8']] },
    {
      mimeType: 'image/webp',
      bytes: [
        [0, 'RIFF'],
        [8, 'WEBP'],
      ],
    },
  ];

/** Bytes needed to recognise every signature above. */
export const IMAGE_SIGNATURE_BYTES = 12;

const matchesAt = (head: Uint8Array, offset: number, ascii: string): boolean =>
  [...ascii].every((char, i) => head[offset + i] === char.charCodeAt(0));

export function detectImage(head: Uint8Array): string | null {
  const signature = IMAGE_SIGNATURES.find(({ bytes }) =>
    bytes.every(([offset, ascii]) => matchesAt(head, offset, ascii)),
  );
  return signature?.mimeType ?? null;
}
