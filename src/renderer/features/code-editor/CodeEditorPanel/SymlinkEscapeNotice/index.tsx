import { Link2 } from 'lucide-react';
import {
  type UseSymlinkEscapeQuery,
  useSymlinkEscape,
} from '@/lib/code-editor/files/use-symlink-escape';

type SymlinkEscapeNoticeProps = {
  useEscapeQuery: UseSymlinkEscapeQuery;
  projectPath: string;
  /** Absolute path of the open file; null while the panel is closed */
  filePath: string | null;
  projectName: string;
  /** False for read-only tabs (images, PDFs), where there is no save to warn about */
  canSave: boolean;
};

/** Says an open file is a link out of its project. Informs only: opening and saving are untouched. */
export function SymlinkEscapeNotice({
  useEscapeQuery,
  projectPath,
  filePath,
  projectName,
  canSave,
}: SymlinkEscapeNoticeProps) {
  const realPath = useSymlinkEscape(useEscapeQuery, projectPath, filePath);
  if (!realPath) return null;

  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 break-words">
        This file is a link to <span className="font-mono text-foreground">{realPath}</span>,
        outside {projectName}.{canSave && ' Saving changes that file.'}
      </p>
    </div>
  );
}
