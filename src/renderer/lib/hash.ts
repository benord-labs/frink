/**
 * Simple fast string hash (djb2) for lightweight content change detection.
 */
export function hashString(str: string): string {
  let hash: number = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
