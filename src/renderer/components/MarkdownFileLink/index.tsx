import { type ReactNode, useContext, useEffect } from 'react';
import { FileLinkBadgeContext } from '../../lib/file-links/file-link-badge-context';
import { FileLinkScopeContext } from '../../lib/file-links/file-link-scope';
import { isBareFileName } from '../../lib/file-links/file-link-target';

type MarkdownFileLinkProps = {
  children?: ReactNode;
  'data-path'?: string;
  'data-line'?: number | string;
  'data-label'?: string;
};

/** Renders the `frink-file` element of the markdown step, placing a bare name through the reply's scope. */
export function MarkdownFileLink({
  children,
  'data-path': path = '',
  'data-line': line,
  'data-label': label = '',
}: MarkdownFileLinkProps) {
  const renderBadge = useContext(FileLinkBadgeContext);
  const scope = useContext(FileLinkScopeContext);
  const register = scope?.register;
  useEffect(() => register?.(path), [register, path]);
  const fileLine = Number(line) || undefined;
  const resolved = isBareFileName(path) ? scope?.resolve(path) : undefined;
  // A bare name with no line is a file only once its reply's lookup finds exactly one.
  if (isBareFileName(path) && !fileLine && !resolved) return children;
  const file = resolved ?? path;
  const suffix = scope?.suffixFor(file);
  return renderBadge?.({ path: file, line: fileLine, label, suffix }) ?? children;
}
