import type { ReactElement, ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import type { TreeProjects } from '@/lib/workspace-context/use-tree-projects';
import { RootCreateContextMenu } from '../../RootCreateContextMenu';
import { MAIN_BADGE } from '../constants';
import { LinkedProjectRoot } from '../LinkedProjectRoot';
import { ProjectRootRow } from '../ProjectRootRow';

type Props = {
  /** The chat's tree projects, from useTreeProjects */
  projects: Pick<TreeProjects, 'main' | 'linked' | 'unlink'>;
  /** The chat whose tree this is */
  chatId: string;
  /** The folder the chat's own tree shows */
  mainPath: string;
  /** The split-view pane the tree sits in */
  paneIndex?: number;
  /** The tree's name filter, already debounced */
  searchQuery: string;
  /** Gives each linked project's tree its own drag and drop context, for a host without a shared one */
  manageDnd?: boolean;
  /** Whether the chat's own files show. The host keeps it, so its shortcuts can skip a hidden tree. */
  mainExpanded: boolean;
  onMainExpandedChange: (expanded: boolean) => void;
  /** Starts a new file or folder at the top of the chat's tree, from Main's right-click menu */
  onCreateInMain: (type: 'file' | 'folder') => void;
  /** The chat's own tree */
  children: ReactNode;
};

/**
 * A chat's file tree with the projects linked to it. With none, the chat's tree shows as it always
 * has. With some, one scroll area holds a "Main" row over the chat's tree, then a read-only section
 * per linked project. The chat's tree is never remounted, so linking, unlinking or collapsing a
 * project keeps its open folders.
 */
export function TreeRootsLayout({
  projects: { main, linked, unlink },
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
  /** The project the x is unlinking, kept until its row goes, the unlink fails or the chat changes */
  const removed = useRef<{ chatId: string; id: string; index: number } | null>(null);
  const mainRow = linked.length > 0 ? main : null;

  // Once the x has unlinked a project and its row is gone, focus moves to the next project's row,
  // else to "Main", else (no project left) to the chat's tree, rather than falling to the page.
  // Another chat's tree lacks that row too, so a switch first drops the pending move.
  useEffect(() => {
    const pending = removed.current;
    if (!pending) return;
    if (pending.chatId !== chatId) {
      removed.current = null;
      return;
    }
    if (linked.some((project) => project.id === pending.id)) return;
    const { index } = pending;
    removed.current = null;
    const rows = layoutRef.current?.querySelectorAll<HTMLElement>('[data-root-row]');
    const next = rows?.[index + 1] ?? rows?.[0];
    (next ?? layoutRef.current?.querySelector<HTMLElement>('[role="tree"]'))?.focus();
  });

  // Without linked projects both wrappers are display: contents, so the host's layout is unchanged.
  return (
    <div
      ref={layoutRef}
      className={
        mainRow
          ? 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin'
          : 'contents'
      }
    >
      {mainRow && (
        // With linked projects below it the chat's tree has no empty space to right-click, so Main
        // offers the tree's root menu.
        <RootCreateContextMenu
          onCreate={(type) => {
            onMainExpandedChange(true);
            onCreateInMain(type);
          }}
        >
          <div>
            <ProjectRootRow
              name={mainRow.name}
              path={mainPath}
              branch={mainRow.branch}
              badge={MAIN_BADGE}
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
        hidden={mainRow !== null && !mainExpanded}
        className={mainRow ? undefined : 'contents'}
      >
        {children}
      </div>
      {mainRow &&
        linked.map((project, index) => (
          <LinkedProjectRoot
            // Another chat, or a new folder for the same project, starts a fresh section with
            // nothing selected.
            key={`${chatId}:${project.id}:${project.path}`}
            project={project}
            chatId={chatId}
            paneIndex={paneIndex}
            searchQuery={searchQuery}
            manageDnd={manageDnd}
            onUnlink={() => {
              const pending = { chatId, id: project.id, index };
              removed.current = pending;
              // A refused unlink keeps the row, and focus stays on its x.
              unlink(project.id, {
                onError: () => {
                  if (removed.current === pending) removed.current = null;
                },
              });
            }}
          />
        ))}
    </div>
  );
}

/** Focuses the chat's tree, or its Main row while that row has the tree closed. */
export function focusChatTree(tree: HTMLElement | null): void {
  const closed = tree?.closest<HTMLElement>('[data-chat-tree][hidden]');
  const row = closed?.parentElement?.querySelector<HTMLElement>(
    `[aria-controls="${CSS.escape(closed.id)}"]`,
  );
  (row ?? tree)?.focus();
}
