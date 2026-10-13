import { useAtomValue } from 'jotai';
import path from 'path';
import type { ReactNode } from 'react';
import { FileLinkBadgeContext, type FileReference } from '@/lib/file-links/file-link-badge-context';
import { fileLinkOpenInput, isFileNameLabel } from '@/lib/file-links/file-link-target';
import { useOpenFileLink } from '@/lib/file-links/use-open-file-link';
import { trpc } from '@/lib/trpc';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { splitViewChatIdsAtom } from '../../atoms';
import {
  useCurrentChatId,
  useCurrentChatWorktree,
} from '../../context/current-chat-worktree-context';
import { AgentFileItem } from '../../ui/agent-file-item';

type FileLinkBadgeProps = {
  reference: FileReference;
  /** Opens the file in the editor; without it the badge only tells where the file is. */
  onOpen?: () => void;
};

/** A file named in chat markdown as a mention badge, with its path in the tooltip. */
export function FileLinkBadge({ reference, onOpen }: FileLinkBadgeProps) {
  const { label } = reference;
  const isName = isFileNameLabel(label, reference);
  return (
    <>
      {/* The text the badge stands in for stays in the page unseen, for chat search and for copying;
          a ring marks the badge while the current search match sits inside that text. */}
      {isName ? (
        <span
          aria-hidden
          data-search-stand-in
          className="sr-only [&[data-search-current]+*]:ring-2"
        >
          {label}
        </span>
      ) : (
        label
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <AgentFileItem
            filename={path.basename(reference.path)}
            detail={reference.line ? `L${reference.line}` : undefined}
            className={isName ? undefined : 'ml-1'}
            tabIndex={0}
            asButton={Boolean(onOpen)}
            skipSelection
            onClick={onOpen}
            data-search-skip
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono wrap-anywhere">
          {path.normalize(reference.path)}
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/** The folder of a chat's project; a `virtual://` project only groups chats and has none. */
function projectFolder(chat: { project: { path: string } | null } | null): string | undefined {
  const folder = chat?.project?.path;
  return folder?.startsWith('virtual://') ? undefined : folder;
}

/** A badge in a chat's transcript, which opens its file when that lies in the folder the chat works in. */
function TranscriptFileLinkBadge({ reference }: { reference: FileReference }) {
  const chatId = useCurrentChatId();
  const worktreePath = useCurrentChatWorktree();
  const paneChatIds = useAtomValue(splitViewChatIdsAtom);
  const home = trpc.external.getHomePath.useQuery(undefined, { staleTime: 300_000 }).data;
  // A chat with no worktree works in its project's folder. The chat view keeps that answer fresh.
  const projectPath = trpc.chats.get.useQuery(
    { id: chatId ?? '' },
    { enabled: Boolean(chatId) && !worktreePath, staleTime: Infinity, select: projectFolder },
  ).data;
  // The tab belongs to the split-view pane the chat sits in; single view has no panes.
  const paneIndex = chatId && paneChatIds.length > 1 ? paneChatIds.indexOf(chatId) : -1;
  const open = useOpenFileLink(paneIndex < 0 ? undefined : paneIndex);
  const input = fileLinkOpenInput(reference.path, {
    home,
    root: worktreePath ?? projectPath,
    isWorktreeContext: worktreePath !== null,
    chatId,
  });
  const onOpen = input ? () => void open(input, reference) : undefined;
  return <FileLinkBadge reference={reference} onOpen={onOpen} />;
}

function renderFileLinkBadge(reference: FileReference): ReactNode {
  return <TranscriptFileLinkBadge reference={reference} />;
}

/** Draws file references in the markdown below as badges. */
export function FileLinkBadgeProvider({ children }: { children: ReactNode }) {
  return <FileLinkBadgeContext value={renderFileLinkBadge}>{children}</FileLinkBadgeContext>;
}
