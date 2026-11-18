import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { ProjectPicker } from '@/components/ProjectPicker';
import { trpc } from '@/lib/trpc';
import { findMentionedProjectIds } from '@/lib/workspace-context/mentioned-projects';
import { useTreeProjects } from '@/lib/workspace-context/use-tree-projects';

type Props = {
  chatId: string | undefined;
  /** The button that opens the picker */
  trigger: ReactElement;
  /** Shown beside the trigger on hover and focus */
  tooltip?: ReactNode;
  /** The chat's loaded message texts; the projects they name by folder are listed first */
  getMentionTexts?: () => string[];
};

type Project = { id: string; path: string };

/** The candidates the texts name. The projects already linked are matched too, so a path in
 *  one nested inside a candidate marks only that deeper project, not the candidate around it. */
function mentionedCandidateIds(texts: string[], linked: Project[], candidates: Project[]) {
  const candidateIds = new Set(candidates.map((project) => project.id));
  return findMentionedProjectIds(texts, [...linked, ...candidates]).filter((id) =>
    candidateIds.has(id),
  );
}

/**
 * Opens a picker of the user's other projects; the one picked is linked to the chat. Nothing shows
 * for a chat without a project folder of its own.
 */
export function LinkProjectPicker({
  chatId,
  trigger,
  tooltip = 'Link another project to this chat',
  getMentionTexts,
}: Props): ReactElement | null {
  // What the chat can link is read only while the picker is open: the server checks each
  // project's folder on disk to answer.
  const [open, setOpen] = useState(false);
  const { main, linked, candidates, projectsStatus, link } = useTreeProjects(chatId, {
    withCandidates: open,
  });
  const utils = trpc.useUtils();
  // Read as the picker opens and dropped as it closes, so nothing is scanned while the chat
  // streams. Kept as texts rather than ids, so projects that finish loading later still match,
  // and with the chat they were read from, so they never mark projects for another chat.
  const [mention, setMention] = useState<{ chatId: string | undefined; texts: string[] } | null>(
    null,
  );
  if (!main) return null;

  return (
    <ProjectPicker
      trigger={trigger}
      tooltip={tooltip}
      candidates={candidates}
      takenNames={[main.name, ...linked.map((project) => project.name)]}
      mentionedIds={
        mention && mention.chatId === chatId
          ? mentionedCandidateIds(mention.texts, linked, candidates)
          : []
      }
      onOpenChange={(next) => {
        setOpen(next);
        setMention(next && getMentionTexts ? { chatId, texts: getMentionTexts() } : null);
        // A folder removed since the list was last read drops out of it.
        if (next) void utils.chats.linkableProjects.invalidate({ chatId: chatId ?? '' });
      }}
      status={projectsStatus}
      footer={`Linked projects are saved on this chat. The agent can read most files in them without asking, except on Codex; changes there are handled like any change outside the chat's folder. The chat's folder, branch and worktree stay on ${main.name}.`}
      onPick={link}
    />
  );
}
