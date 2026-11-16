import { decodeUriPath } from '../../shared/lib/path-normalization';

export function getDecodedBasename(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const rawName = normalizedPath.split('/').pop() ?? filePath;
  return decodeUriPath(rawName);
}
