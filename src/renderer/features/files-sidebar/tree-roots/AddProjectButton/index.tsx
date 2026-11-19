import { Button } from '@benord-labs/frink-primitives';
import { FolderPlus } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ProjectPicker } from '@/components/ProjectPicker';
import { findMentionedProjectIds } from '@/lib/workspace-context/mentioned-projects';
import { useTreeProjects } from '@/lib/workspace-context/use-tree-projects';

type Props = {
  chatId: string | undefined;
  /** The chat's loaded message texts; the projects they name by folder are listed first */
  getMentionTexts?: () => string[];
};

type Project = { id: string; path: string };

/** The candidates the texts name. The projects already in the tree are matched too, so a path in
 *  one nested inside a candidate marks only that deeper project, not the candidate around it. */
function mentionedCandidateIds(texts: string[], extras: Project[], candidates: Project[]) {
  const candidateIds = new Set(candidates.map((project) => project.id));
  return findMentionedProjectIds(texts, [...extras, ...candidates]).filter((id) =>
    candidateIds.has(id),
  );
}

/**
 * Opens a picker of the user's other projects; the one picked shows below the chat's own project in
 * its file tree. Nothing shows for a chat without a project folder of its own.
 */
export function AddProjectButton({ chatId, getMentionTexts }: Props): ReactElement | null {
  const { main, extras, candidates, projectsStatus, canAdd, add } = useTreeProjects(chatId);
  // Read as the picker opens and dropped as it closes, so nothing is scanned while the chat
  // streams. Kept as texts rather than ids, so projects that finish loading later still match,
  // and with the chat they were read from, so they never mark projects for another chat.
  const [mention, setMention] = useState<{ chatId: string | undefined; texts: string[] } | null>(
    null,
  );
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
      mentionedIds={
        mention && mention.chatId === chatId
          ? mentionedCandidateIds(mention.texts, extras, candidates)
          : []
      }
      onOpenChange={(open) =>
        setMention(open && getMentionTexts ? { chatId, texts: getMentionTexts() } : null)
      }
      status={projectsStatus}
      footer={`Only changes this chat's file tree. The chat, its agent and its branch stay on ${main.name}.`}
      onPick={add}
    />
  );
}
