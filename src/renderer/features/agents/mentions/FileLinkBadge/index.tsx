import { useAtomValue } from 'jotai';
import path from 'path';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { FileLinkBadgeContext, type FileReference } from '@/lib/file-links/file-link-badge-context';
import {
  buildFileLinkLabels,
  type FileLinkLabels,
  FileLinkScopeContext,
} from '@/lib/file-links/file-link-scope';
import {
  fileLinkOpenInput,
  isBareFileName,
  isFileNameLabel,
} from '@/lib/file-links/file-link-target';
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

/** What follows the file's name: the folders that tell it from a same-name file, then its line. */
function badgeDetail({ suffix, line }: FileReference): string | undefined {
  return [suffix, line && `L${line}`].filter(Boolean).join(' · ') || undefined;
}

/** A file named in chat markdown as a mention badge, with its path in the tooltip. */
export function FileLinkBadge({ reference, onOpen }: FileLinkBadgeProps) {
  const { label } = reference;
  const isName = isFileNameLabel(label, reference);
  // `relative` anchors the absolutely positioned stand-in here: inside a capped scroller (a plan
  // card) it is then clipped, rather than stretching the transcript to its unclipped position.
  return (
    <span className="relative">
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
            detail={badgeDetail(reference)}
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
    </span>
  );
}

/** The folder of a chat's project; a `virtual://` project only groups chats and has none. */
function projectFolder(chat: { project: { path: string } | null } | null): string | undefined {
  const folder = chat?.project?.path;
  return folder?.startsWith('virtual://') ? undefined : folder;
}

/** The chat around a badge and the folder it works in: its worktree, else its project's folder. */
function useChatFileRoot() {
  const chatId = useCurrentChatId();
  const worktreePath = useCurrentChatWorktree();
  // The chat view keeps the project answer fresh.
  const projectPath = trpc.chats.get.useQuery(
    { id: chatId ?? '' },
    { enabled: Boolean(chatId) && !worktreePath, staleTime: Infinity, select: projectFolder },
  ).data;
  return { chatId, worktreePath, root: worktreePath ?? projectPath };
}

/** A badge in a chat's transcript, which opens its file when that lies in the folder the chat works in. */
function TranscriptFileLinkBadge({ reference }: { reference: FileReference }) {
  const { chatId, worktreePath, root } = useChatFileRoot();
  const paneChatIds = useAtomValue(splitViewChatIdsAtom);
  const home = trpc.external.getHomePath.useQuery(undefined, { staleTime: 300_000 }).data;
  // The tab belongs to the split-view pane the chat sits in; single view has no panes.
  const paneIndex = chatId && paneChatIds.length > 1 ? paneChatIds.indexOf(chatId) : -1;
  const open = useOpenFileLink(paneIndex < 0 ? undefined : paneIndex);
  const input = fileLinkOpenInput(reference.path, {
    home,
    root,
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

const MAX_RESOLVED_NAMES = 200;

const NO_LABELS: FileLinkLabels = { resolve: () => undefined, suffixFor: () => undefined };

/** The references a reply's badges render, each counted until its last badge unmounts. */
function useRenderedReferences() {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const register = useCallback((file: string) => {
    const change = (delta: number) =>
      setCounts((previous) => {
        const next = new Map(previous);
        const count = (next.get(file) ?? 0) + delta;
        if (count > 0) next.set(file, count);
        else next.delete(file);
        return next;
      });
    change(1);
    return () => change(-1);
  }, []);
  return { references: useMemo(() => [...counts.keys()], [counts]), register };
}

type FileLinkScopeProps = { isStreaming: boolean; children: ReactNode };

/** Places the bare file names one agent reply renders and labels its same-name files, once it stops
 * streaming. The references come from the badges themselves, so they are read exactly as rendered. */
export function FileLinkScope({ isStreaming, children }: FileLinkScopeProps) {
  const { root } = useChatFileRoot();
  const { references, register } = useRenderedReferences();
  const names = isStreaming ? [] : references.filter(isBareFileName).slice(0, MAX_RESOLVED_NAMES);
  const resolved = trpc.files.resolveNames.useQuery(
    { projectPath: root ?? '', names },
    { enabled: Boolean(root) && names.length > 0, staleTime: 30_000 },
  ).data;
  const labels = useMemo(
    () => (isStreaming ? NO_LABELS : buildFileLinkLabels(references, resolved, root)),
    [isStreaming, references, resolved, root],
  );
  const scope = useMemo(() => ({ ...labels, register }), [labels, register]);
  return <FileLinkScopeContext value={scope}>{children}</FileLinkScopeContext>;
}
