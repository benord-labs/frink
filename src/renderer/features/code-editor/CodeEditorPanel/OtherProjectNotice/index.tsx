import { Eye } from 'lucide-react';
import { pathLabel } from '../../../../../shared/lib/mentions/parse-mention';
import {
  isSameFolder,
  normalizePathSlashes,
  trimTrailingSlashes,
} from '../../../../../shared/lib/path-normalization';
import type { OpenFile } from '@/lib/code-editor/state';
import { trpc } from '@/lib/trpc';

type OtherProjectNoticeProps = {
  /** The active tab; null when none is open */
  file: Pick<OpenFile, 'projectPath' | 'isOtherProject'> | null;
};

/** Says the open file is from another project. Informs only: browsing changes no agent access. */
export function OtherProjectNotice({ file }: OtherProjectNoticeProps) {
  const projectPath = file?.isOtherProject ? file.projectPath : undefined;
  const { data, isError } = trpc.projects.list.useQuery(undefined, {
    enabled: Boolean(projectPath),
  });
  // While the list loads, show nothing rather than the folder name in place of the project's own.
  if (!projectPath || (!Array.isArray(data) && !isError)) return null;

  const registered = Array.isArray(data)
    ? data.find((project) => isSameFolder(project.path, projectPath))
    : undefined;
  const projectName =
    registered?.name ?? pathLabel(trimTrailingSlashes(normalizePathSlashes(projectPath)));

  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 break-words">
        You're browsing <span className="text-foreground">{projectName}</span>. Browsing doesn't
        change what the agent can read.
      </p>
    </div>
  );
}
