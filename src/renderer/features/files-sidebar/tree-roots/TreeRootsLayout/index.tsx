import type { ReactElement, ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import type { TreeProjects } from '@/lib/workspace-context/use-tree-projects';
import { RootCreateContextMenu } from '../../RootCreateContextMenu';
import { ExtraProjectRoot } from '../ExtraProjectRoot';
import { ProjectRootRow } from '../ProjectRootRow';

const THIS_CHAT_BADGE = { label: 'This chat', tone: 'main' } as const;

type Props = {
  /** The chat's tree projects, from useTreeProjects */
  projects: Pick<TreeProjects, 'main' | 'extras' | 'remove'>;
  /** The chat whose tree this is */
  chatId: string;
  /** The folder the chat's own tree shows */
  mainPath: string;
  /** The split-view pane the tree sits in */
  paneIndex?: number;
  /** The tree's name filter, already debounced */
  searchQuery: string;
  /** Gives each other project's tree its own drag and drop context, for a host without a shared one */
  manageDnd?: boolean;
  /** Whether the chat's own files show. The host keeps it, so its shortcuts can skip a hidden tree. */
  mainExpanded: boolean;
  onMainExpandedChange: (expanded: boolean) => void;
  /** Starts a new file or folder at the top of the chat's tree, from This chat's right-click menu */
  onCreateInMain: (type: 'file' | 'folder') => void;
  /** The chat's own tree */
  children: ReactNode;
};

/**
 * A chat's file tree with the other projects added to it. With none, the chat's tree shows as it
 * always has. With some, one scroll area holds a "This chat" row over the chat's tree, then a
 * read-only section per added project. The chat's tree is never remounted, so adding, removing or
 * collapsing a project keeps its open folders.
 */
export function TreeRootsLayout({
  projects: { main, extras, remove },
  chatId,
  mainPath,
  paneIndex,
  searchQuery,
  manageDnd,
  mainExpanded,
  onMainExpandedChange,
  onCreateInMain,
  children,
}: Props): ReactElement {
  const mainId = useId();
  const layoutRef = useRef<HTMLDivElement>(null);
  const removedAt = useRef<number | null>(null);
  const thisChat = extras.length > 0 ? main : null;

  // Once the x has taken a project out, focus moves to the next project's row, else to "This
  // chat", else (no project left) to the chat's tree, rather than falling to the page.
  useEffect(() => {
    const index = removedAt.current;
    if (index === null) return;
    removedAt.current = null;
    const rows = layoutRef.current?.querySelectorAll<HTMLElement>('[data-root-row]');
    const next = rows?.[index + 1] ?? rows?.[0];
    (next ?? layoutRef.current?.querySelector<HTMLElement>('[role="tree"]'))?.focus();
  });

  // Without extra projects both wrappers are display: contents, so the host's layout is unchanged.
  return (
    <div
      ref={layoutRef}
      className={
        thisChat
          ? 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin'
          : 'contents'
      }
    >
      {thisChat && (
        // With other projects below it the chat's tree has no empty space to right-click, so This
        // chat offers the tree's root menu.
        <RootCreateContextMenu
          onCreate={(type) => {
            onMainExpandedChange(true);
            onCreateInMain(type);
          }}
        >
          <div>
            <ProjectRootRow
              name={thisChat.name}
              path={mainPath}
              branch={thisChat.branch}
              badge={THIS_CHAT_BADGE}
              expanded={mainExpanded}
              onExpandedChange={onMainExpandedChange}
              controlsId={mainId}
            />
          </div>
        </RootCreateContextMenu>
      )}
      <div
        id={mainId}
        data-chat-tree
        hidden={thisChat !== null && !mainExpanded}
        className={thisChat ? undefined : 'contents'}
      >
        {children}
      </div>
      {thisChat &&
        extras.map((project, index) => (
          <ExtraProjectRoot
            // Another chat, or a new folder for the same project, starts a fresh section with
            // nothing selected.
            key={`${chatId}:${project.id}:${project.path}`}
            project={project}
            chatId={chatId}
            paneIndex={paneIndex}
            searchQuery={searchQuery}
            manageDnd={manageDnd}
            onRemove={() => {
              removedAt.current = index;
              remove(project.id);
            }}
          />
        ))}
    </div>
  );
}

/** Focuses the chat's tree, or its This chat row while that row has the tree closed. */
export function focusChatTree(tree: HTMLElement | null): void {
  const closed = tree?.closest<HTMLElement>('[data-chat-tree][hidden]');
  const row = closed?.parentElement?.querySelector<HTMLElement>(
    `[aria-controls="${CSS.escape(closed.id)}"]`,
  );
  (row ?? tree)?.focus();
}
