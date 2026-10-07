/** Bytes a base64 string decodes to, from its length and padding alone. */
export function decodedBytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}
