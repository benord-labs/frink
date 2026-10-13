import { type ReactNode, useContext } from 'react';
import { FileLinkBadgeContext } from '../../lib/file-links/file-link-badge-context';

type MarkdownFileLinkProps = {
  children?: ReactNode;
  'data-path'?: string;
  'data-line'?: number | string;
  'data-label'?: string;
};

/** A file reference in rendered markdown: the surface's badge when it draws one, else the original markdown. */
export function MarkdownFileLink({
  children,
  'data-path': path = '',
  'data-line': line,
  'data-label': label = '',
}: MarkdownFileLinkProps) {
  const renderBadge = useContext(FileLinkBadgeContext);
  return renderBadge?.({ path, line: Number(line) || undefined, label }) ?? children;
}
