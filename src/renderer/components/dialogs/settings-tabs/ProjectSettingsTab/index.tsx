import { useIsNarrowScreen } from '@/hooks/use-is-narrow-screen';
import { isBuildProjectPath } from '@/lib/build-project';
import { cn } from '@/lib/utils';
import { ProjectAiAccountSelector } from '../ProjectAiAccountSelector';
import { SettingsTabHeader } from '../SettingsTabHeader';
import { SETTINGS_TAB_PAGE_CLASS } from '../settings-tab-surface';
import { ProjectWorktreeSettings } from './ProjectWorktreeSettings';

/** Chat-only folders: a project row with no directory behind it. */
const VIRTUAL_FOLDER_PREFIX = 'virtual://folders/';

type Props = {
  project: { id: string; path: string };
  title: string;
};

export function ProjectSettingsTab({ project, title }: Props) {
  const isNarrowScreen = useIsNarrowScreen();
  const isVirtualFolder = project.path.startsWith(VIRTUAL_FOLDER_PREFIX);
  // Worktrees need a git checkout: chat folders have no directory and Frink builds have no git.
  const hasWorktrees = !isVirtualFolder && !isBuildProjectPath(project.path);

  return (
    <div className={cn(SETTINGS_TAB_PAGE_CLASS, 'min-h-0')}>
      <SettingsTabHeader
        title={title}
        description={
          isVirtualFolder ? (
            'A folder for organizing chats.'
          ) : (
            <span className="break-all font-mono text-xs">{project.path}</span>
          )
        }
        narrow={isNarrowScreen}
      />
      <ProjectAiAccountSelector projectId={project.id} />
      {hasWorktrees && <ProjectWorktreeSettings projectId={project.id} />}
    </div>
  );
}
