import { toast } from 'sonner';

export type CopyAcrossResult = {
  copied: string[];
  skipped: string[];
  committedRepo: boolean;
  error?: string;
};

/**
 * The ONE truthful toast for a `copyAcross` result — shared by every resource (skills, agents) and every
 * entry point (the Settings "Copy across…" action and the spawn-time un-bridged prompt) so they can never
 * drift. `noun` is the resource word ('skill' | 'agent'). Names what was copied AND what hand-edited copies
 * were kept; appends the repo-add note when files landed in a project.
 */
export function showCopyResultToast(res: CopyAcrossResult, noun = 'skill'): void {
  if (res.error) {
    toast.error(res.error);
    return;
  }
  const parts: string[] = [];
  if (res.copied.length > 0) {
    parts.push(`Copied ${res.copied.length} ${noun}${res.copied.length === 1 ? '' : 's'}`);
  }
  if (res.skipped.length > 0) {
    parts.push(`kept your edited copy of ${res.skipped.join(', ')}`);
  }
  const msg = parts.join(' — ') || 'Nothing to copy';
  toast.success(res.committedRepo ? `${msg} (added to the project's repo)` : msg);
}
