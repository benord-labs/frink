export function getDecodedBasename(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const rawName = normalizedPath.split('/').pop() ?? filePath;

  try {
    return decodeURIComponent(rawName);
  } catch {
    return rawName;
  }
}
