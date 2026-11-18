import { Button } from '@benord-labs/frink-primitives';
import { Eye, Link } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { pathLabel } from '../../../../../shared/lib/mentions/parse-mention';
import {
  isSameFolder,
  normalizePathSlashes,
  trimTrailingSlashes,
} from '../../../../../shared/lib/path-normalization';
import type { OpenFile } from '@/lib/code-editor/state';
import { trpc } from '@/lib/trpc';
import { findProjectForPath } from '@/lib/workspace-context/project-paths';
import { useTreeProjects } from '@/lib/workspace-context/use-tree-projects';

type OtherProjectNoticeProps = {
  /** The active tab; null when none is open */
  file: Pick<OpenFile, 'projectPath' | 'isOtherProject' | 'sourceChatId'> | null;
  /** The chat the editor follows, which the notice calls "this chat": single view's chat or the
   *  active pane's. Null for a new-chat form or an empty pane, which link nothing. */
  chatId: string | null;
};

/** Says the open file is from another project and whether that project, or one holding it, is
 *  linked to the chat on screen. When that chat opened the tab and can link the project, offers to. */
export function OtherProjectNotice({ file, chatId }: OtherProjectNoticeProps) {
  const projectPath = file?.isOtherProject ? file.projectPath : undefined;
  // Only the chat that opened the tab offers to link it, so the button never links a chat that the
  // tab merely stayed open over.
  const mayOffer = Boolean(chatId) && file?.sourceChatId === chatId;
  const chat = useTreeProjects(projectPath ? chatId : undefined, { withCandidates: mayOffer });
  const { data, isError } = trpc.projects.list.useQuery(undefined, {
    enabled: Boolean(projectPath),
  });
  const statusRef = useRef<HTMLParagraphElement>(null);
  const linkStarted = useRef(false);
  // The agent reads anything inside a linked folder, so a project nested in one counts as linked.
  const holder = projectPath ? findProjectForPath(projectPath, chat.extras) : null;
  const isLinked = holder !== null;
  const through =
    holder && !isSameFolder(holder.path, projectPath) ? ` is inside ${holder.name}, which` : '';

  // The button goes once its link is made, so focus moves to the notice rather than the page.
  useEffect(() => {
    if (!linkStarted.current || (!isLinked && chat.isPending)) return;
    linkStarted.current = false;
    const dropped = !document.activeElement || document.activeElement === document.body;
    if (isLinked && dropped) statusRef.current?.focus();
  }, [isLinked, chat.isPending]);

  // While the list or the chat loads, show nothing rather than a name or state that may change:
  // that includes what the chat can link, while a Link project button may join the notice.
  const offerLoading = mayOffer && !isLinked && chat.canAdd && chat.projectsStatus === 'pending';
  if (!projectPath || !chat.isLoaded || (!Array.isArray(data) && !isError) || offerLoading) {
    return null;
  }

  const registered = Array.isArray(data)
    ? data.find((project) => isSameFolder(project.path, projectPath))
    : undefined;
  const projectName =
    registered?.name ?? pathLabel(trimTrailingSlashes(normalizePathSlashes(projectPath)));
  const linkable =
    isLinked || !mayOffer
      ? undefined
      : chat.candidates.find((project) => isSameFolder(project.path, projectPath));
  const Icon = isLinked ? Link : Eye;

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="min-w-0 flex-1 break-words outline-hidden"
      >
        <span className="text-foreground">{projectName}</span>
        {isLinked
          ? `${through} is linked to this chat. The agent can read most files here without asking, except on Codex.`
          : linkable
            ? " isn't linked to this chat. Link it to let the agent read most files here without asking, except on Codex."
            : " isn't linked to this chat."}
      </p>
      {linkable && (
        <Button
          variant="secondary"
          size="xs"
          loading={chat.isPending}
          onClick={() => {
            linkStarted.current = true;
            chat.add(linkable.id);
          }}
        >
          Link project
        </Button>
      )}
    </div>
  );
}
