import { Eye } from 'lucide-react';

/** The label on the chat's own project, wherever the tree lists it beside other projects. */
export const THIS_CHAT_BADGE = { label: 'This chat', tone: 'main' } as const;
/** The label on a project added to the chat's tree. */
export const BROWSING_BADGE = { label: 'Browsing', icon: Eye, tone: 'browse' } as const;
/** One project's search results inside a scroll area that holds every project's. */
export const SEARCH_SECTION_CLASS = 'flex-none overflow-visible py-1';
/** Window focus re-reads an added project's files, or its search matches, at most this often. */
export const FOCUS_REFRESH_MS = 30_000;
