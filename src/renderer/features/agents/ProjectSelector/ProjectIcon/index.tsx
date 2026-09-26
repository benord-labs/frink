import { Box, FolderOpen } from 'lucide-react';
import { GitHubAvatar } from '../../../../components/GitHubAvatar';

// Helper component to render project icon (avatar or folder)
export function ProjectIcon({
  gitOwner,
  gitProvider,
  fallbackGitOwner,
  fallbackGitProvider,
  className = 'h-4 w-4',
  isBuild = false,
}: {
  gitOwner?: string | null;
  gitProvider?: string | null;
  /** Used when primary git fields are unset (e.g. validSelection missing but atom/parent has metadata). */
  fallbackGitOwner?: string | null;
  fallbackGitProvider?: string | null;
  className?: string;
  /** Frink-managed build project (path under ~/.frink/builds) — distinct icon. */
  isBuild?: boolean;
}) {
  const effectiveOwner = gitOwner ?? fallbackGitOwner;
  const effectiveProvider = gitProvider ?? fallbackGitProvider;
  const folder = <FolderOpen className={`${className} text-muted-foreground shrink-0`} />;

  // Frink-managed builds get a distinct icon (not a git avatar or generic folder).
  if (isBuild) {
    return <Box className={`${className} text-muted-foreground shrink-0`} />;
  }

  // Without a GitHub owner, show a folder instead of a remote avatar.
  if (!effectiveOwner || effectiveProvider !== 'github') {
    return folder;
  }

  return <GitHubAvatar gitOwner={effectiveOwner} className={className} errorFallback={folder} />;
}
