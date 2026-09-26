import { Button } from '@benord-labs/frink-primitives';
import { isBuildProjectPath } from '@/lib/build-project';
import { CSS_CLASSES, STRINGS } from '../main/new-chat-form-constants';

type WorktreeBannerProps = {
  onConfigure: () => void;
  onDismiss: () => void;
};

type WorktreeBannerVisibility = {
  workMode: string;
  projectPath: string | undefined;
  dismissed: boolean;
  configData: { config: unknown } | null | undefined;
};

// Worktree mode, a project that can have worktrees (Frink builds have no git), not dismissed, and
// a resolved query with no config — never while loading (configData undefined), so it can't flash.
export function shouldShowWorktreeBanner({
  workMode,
  projectPath,
  dismissed,
  configData,
}: WorktreeBannerVisibility): boolean {
  return (
    workMode === 'worktree' &&
    !!projectPath &&
    !isBuildProjectPath(projectPath) &&
    !dismissed &&
    !!configData &&
    !configData.config
  );
}

/**
 * Banner shown when worktree mode is enabled but no config is set
 */
export function WorktreeBanner({ onConfigure, onDismiss }: WorktreeBannerProps) {
  return (
    <div className={CSS_CLASSES.WORKTREE_BANNER}>
      <p className="text-sm text-muted-foreground">{STRINGS.WORKTREE_BANNER_MESSAGE}</p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {STRINGS.BUTTON_DISMISS}
        </Button>
        <Button variant="secondary" size="sm" onClick={onConfigure}>
          {STRINGS.BUTTON_SETTINGS}
        </Button>
      </div>
    </div>
  );
}
