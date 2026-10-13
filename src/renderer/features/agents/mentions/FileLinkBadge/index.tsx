import path from 'path';
import type { ReactNode } from 'react';
import { FileLinkBadgeContext, type FileReference } from '@/lib/file-links/file-link-badge-context';
import { isFileNameLabel } from '@/lib/file-links/file-link-target';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { AgentFileItem } from '../../ui/agent-file-item';

/** A file named in chat markdown as a mention badge, with its path in the tooltip. */
export function FileLinkBadge({ reference }: { reference: FileReference }) {
  const { label } = reference;
  return (
    <>
      {/* The text the badge stands in for stays in the page, unseen and uncopied, so chat search
          still finds it; a ring marks the badge while the current match sits inside that text. */}
      {isFileNameLabel(label, reference) ? (
        <span
          aria-hidden
          data-search-stand-in
          className="sr-only select-none [&[data-search-current]+*]:ring-2"
        >
          {label}
        </span>
      ) : (
        `${label} `
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <AgentFileItem
            filename={path.basename(reference.path)}
            detail={reference.line ? `L${reference.line}` : undefined}
            tabIndex={0}
            data-search-skip
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono wrap-anywhere">
          {path.normalize(reference.path)}
        </TooltipContent>
      </Tooltip>
    </>
  );
}

function renderFileLinkBadge(reference: FileReference): ReactNode {
  return <FileLinkBadge reference={reference} />;
}

/** Draws file references in the markdown below as badges. */
export function FileLinkBadgeProvider({ children }: { children: ReactNode }) {
  return <FileLinkBadgeContext value={renderFileLinkBadge}>{children}</FileLinkBadgeContext>;
}
