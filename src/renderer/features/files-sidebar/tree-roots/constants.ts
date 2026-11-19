import { Link } from 'lucide-react';

/** The label on the chat's own project, wherever the tree lists it beside linked projects. */
export const MAIN_BADGE = {
  label: 'Main',
  tone: 'main',
  hint: 'The working folder, branch, worktree and CLAUDE.md come from here.',
} as const;
/** The label on a project linked to the chat. */
export const LINKED_BADGE = { label: 'Linked', icon: Link, tone: 'linked' } as const;
/** One project's search results inside a scroll area that holds every project's. */
export const SEARCH_SECTION_CLASS = 'flex-none overflow-visible py-1';
/** Window focus re-reads a linked project's files, or its search matches, at most this often. */
export const FOCUS_REFRESH_MS = 30_000;
