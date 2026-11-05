import { Button } from '@benord-labs/frink-primitives';
import { FolderPlus } from 'lucide-react';
import type { ReactElement } from 'react';
import { ProjectPicker } from '@/components/ProjectPicker';
import { useTreeProjects } from '@/lib/workspace-context/use-tree-projects';

/**
 * Opens a picker of the user's other projects; the one picked shows below the chat's own project in
 * its file tree. Nothing shows for a chat without a project folder of its own.
 */
export function AddProjectButton({ chatId }: { chatId: string | undefined }): ReactElement | null {
  const { main, extras, candidates, projectsStatus, canAdd, add } = useTreeProjects(chatId);
  if (!canAdd || !main) return null;

  return (
    <ProjectPicker
      trigger={
        // Icon only, unless the header (container `files-header`) has room for the label
        <Button
          variant="ghost"
          size="sm"
          aria-label="Add project"
          className="size-8 shrink-0 px-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground @min-[22rem]/files-header:w-auto @min-[22rem]/files-header:px-2"
        >
          <FolderPlus className="h-4 w-4 shrink-0" aria-hidden />
          <span className="hidden @min-[22rem]/files-header:inline">Add project</span>
        </Button>
      }
      tooltip="Add another project to this tree to browse its files"
      candidates={candidates}
      takenNames={[main.name, ...extras.map((project) => project.name)]}
      status={projectsStatus}
      footer={`Only changes this chat's file tree. The chat, its agent and its branch stay on ${main.name}.`}
      onPick={add}
    />
  );
}
