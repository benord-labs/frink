import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const HEADING_ID = 'project-worktree-files-to-copy';

const SKIP_REASONS = {
  'too-large': 'too large to copy',
  symlink: 'linked file, not copied',
} as const;

function sourceHint(source: 'worktreeinclude' | 'default' | undefined, enabled: boolean): string {
  if (!enabled) {
    return "Off: new worktrees start without these files. This choice stays on this computer and isn't saved in the project.";
  }
  if (source === 'worktreeinclude') return 'Using .worktreeinclude from this repository.';
  return "Your .env files, which git doesn't keep. To copy other files too, list them in a .worktreeinclude file.";
}

/** The list comes from the same resolver that copies the files when a worktree is made. */
export function FilesToCopy({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const preview = trpc.worktreeConfig.includePreview.useQuery(
    { projectId },
    { refetchOnMount: 'always' },
  );
  const toggle = trpc.worktreeConfig.setIncludeEnabled.useMutation({
    onError: (err) => toast.error(`Couldn't change this setting: ${err.message}`),
    onSettled: () => utils.worktreeConfig.includePreview.invalidate({ projectId }),
  });
  const data = preview.data;
  const enabled = toggle.isPending ? toggle.variables.enabled : (data?.enabled ?? true);
  const empty = data && data.files.length === 0 && data.skipped.length === 0 && !data.overLimit;

  return (
    <section aria-labelledby={HEADING_ID} className="space-y-2 border-t border-border/60 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p id={HEADING_ID} className="text-sm font-medium">
            Files copied into each new worktree
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {sourceHint(data?.source, enabled)}
          </p>
        </div>
        {data && (
          <Switch
            checked={enabled}
            disabled={toggle.isPending}
            aria-label="Copy these files into each new worktree"
            onCheckedChange={(checked) => toggle.mutate({ projectId, enabled: checked })}
            className="shrink-0 data-[state=unchecked]:border-muted-foreground"
          />
        )}
      </div>
      {preview.isError && (
        <p className="text-xs text-muted-foreground">Couldn't check which files get copied.</p>
      )}
      {empty && <p className="text-xs text-muted-foreground">Nothing to copy right now.</p>}
      {data && !empty && (
        <ul className={cn('space-y-1 font-mono text-xs', !enabled && 'text-muted-foreground')}>
          {data.files.map((file) => (
            <li key={file} className="break-all">
              {file}
            </li>
          ))}
          {data.skipped.map(({ path, reason }) => (
            <li key={path} className="break-all text-muted-foreground">
              {path} <span className="font-sans">({SKIP_REASONS[reason]})</span>
            </li>
          ))}
        </ul>
      )}
      {data && data.overLimit > 0 && (
        <p className="text-xs text-muted-foreground">
          {data.overLimit} more {data.overLimit === 1 ? 'file is' : 'files are'} over the copy limit
          and won't be copied.
        </p>
      )}
    </section>
  );
}
