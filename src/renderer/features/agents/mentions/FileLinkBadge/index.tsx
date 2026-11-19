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
  fileLinkOpenInputAcrossProjects,
  fileLinkOwnMainFolder,
  isBareFileName,
  isFileNameLabel,
} from '@/lib/file-links/file-link-target';
import { useOpenFileLink } from '@/lib/file-links/use-open-file-link';
import { trpc } from '@/lib/trpc';
import { findProjectForPath, isRealProjectPath } from '@/lib/workspace-context/project-paths';
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
  /** The other project the file is from, named on the badge. */
  projectName?: string;
  /** Where the file lies, said on a line of its own above its path in the tooltip. */
  where?: string;
};

/** What follows the file's name: the folders that tell it from a same-name file, then its line. */
function badgeDetail({ suffix, line }: FileReference): string | undefined {
  return [suffix, line && `L${line}`].filter(Boolean).join(' · ') || undefined;
}

/** A file named in chat markdown as a mention badge, with its path in the tooltip. */
export function FileLinkBadge({ reference, onOpen, projectName, where }: FileLinkBadgeProps) {
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
            project={projectName}
            detail={badgeDetail(reference)}
            className={isName ? undefined : 'ml-1'}
            tabIndex={0}
            asButton={Boolean(onOpen)}
            skipSelection
            onClick={onOpen}
            data-search-skip
          />
        </TooltipTrigger>
        <TooltipContent side="top">
          {where && <p>{where}</p>}
          <p className="font-mono wrap-anywhere">{path.normalize(reference.path)}</p>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

type ChatProject = { id: string; name: string; path: string };
type BadgeChat = { project: ChatProject | null; linkedProjects?: Array<{ path: string }> } | null;

/** The chat's own project, which never opens through the other-projects fallback, and the
 *  projects linked to it. */
const badgeChat = (chat: BadgeChat) => ({
  project: chat?.project ?? null,
  linked: chat?.linkedProjects ?? [],
});

/** The chat around a badge, its own project, and the folder it works in: its worktree, else its
 *  project's folder. */
function useChatFileRoot() {
  const chatId = useCurrentChatId();
  const worktreePath = useCurrentChatWorktree();
  // The chat view keeps the chat fresh. A chat with no worktree works in its project's folder.
  const chat = trpc.chats.get.useQuery(
    { id: chatId ?? '' },
    { enabled: Boolean(chatId), staleTime: Infinity, select: badgeChat },
  ).data;
  const project = chat?.project;
  const root = worktreePath ?? (isRealProjectPath(project?.path) ? project?.path : undefined);
  return { chatId, worktreePath, chat, project, root };
}

/** A badge in a chat's transcript, which opens its file when that lies in the folder the chat
 *  works in, or in full or `~/` form in another registered project. */
function TranscriptFileLinkBadge({ reference }: { reference: FileReference }) {
  const { chatId, worktreePath, chat, project, root } = useChatFileRoot();
  const paneChatIds = useAtomValue(splitViewChatIdsAtom);
  const home = trpc.external.getHomePath.useQuery(undefined, { staleTime: 300_000 }).data;
  const rawProjects = trpc.projects.list.useQuery(undefined, {
    enabled: Boolean(chatId),
    staleTime: 300_000,
  }).data;
  // Guards: during tRPC client hydration on dev start (~1-2% of the time), data can
  // briefly be a non-undefined non-array value. See commit a6d57596.
  const projects = Array.isArray(rawProjects) ? rawProjects : [];
  // The tab belongs to the split-view pane the chat sits in; single view has no panes.
  const paneIndex = chatId && paneChatIds.length > 1 ? paneChatIds.indexOf(chatId) : -1;
  const open = useOpenFileLink(paneIndex < 0 ? undefined : paneIndex);
  const base = {
    home,
    root,
    isWorktreeContext: worktreePath !== null,
    chatId,
  };
  const input = fileLinkOpenInputAcrossProjects(reference.path, base, projects, project?.id);
  const mainFolder = !input && fileLinkOwnMainFolder(reference.path, base, projects, project?.id);
  // A project nested in a linked folder is read through that link.
  const linked = input && findProjectForPath(input.projectPath, chat?.linked ?? []) !== null;
  const where = input?.projectName
    ? `In ${input.projectName} · ${linked ? 'linked' : 'not linked'}`
    : mainFolder
      ? `In ${mainFolder.name}'s main folder, not this chat's worktree`
      : undefined;
  const onOpen = input ? () => void open(input, reference) : undefined;
  return (
    <FileLinkBadge
      reference={reference}
      onOpen={onOpen}
      projectName={input?.projectName}
      where={where}
    />
  );
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
  // Sorted, so the lookup is asked again only when the names change, not their order.
  const names = isStreaming
    ? []
    : references.filter(isBareFileName).toSorted().slice(0, MAX_RESOLVED_NAMES);
  const resolved = trpc.files.resolveNames.useQuery(
    { projectPath: root ?? '', names },
    {
      enabled: Boolean(root) && names.length > 0,
      staleTime: 30_000,
      // Placed names stay badges while a lookup for a changed name list is on its way.
      placeholderData: (previous) => previous,
    },
  ).data;
  const labels = useMemo(
    () => (isStreaming ? NO_LABELS : buildFileLinkLabels(references, resolved, root)),
    [isStreaming, references, resolved, root],
  );
  const scope = useMemo(() => ({ ...labels, register }), [labels, register]);
  return <FileLinkScopeContext value={scope}>{children}</FileLinkScopeContext>;
}
