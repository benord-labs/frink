import path from 'path';

/**
 * Encode an absolute file path as a Monaco/file URI string.
 * Shared by alias-definition-provider and project-types.
 * Relative paths are rejected — `file://foo/bar` would parse as host `foo`, not path `/foo/bar` (RFC 8089).
 */
export function encodeFileUri(absolutePath: string): string {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(`encodeFileUri: expected absolute path, got: ${absolutePath}`);
  }
  const encodedPath = absolutePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file://${encodedPath}`;
}
