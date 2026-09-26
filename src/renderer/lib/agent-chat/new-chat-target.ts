/* eslint-disable project-structure/folder-structure */

/**
 * What a new chat is scoped to before send (epic sc-788):
 * - `unset`   — nothing chosen yet; trigger reads "Open project", sending → general chat
 * - `general` — user explicitly chose General chat; sending → general chat
 * - `new`     — user chose New project; sending scaffolds a Frink-managed gitless project
 *
 * `unset` and `general` both send a general chat (no project); only `new` scaffolds.
 */
export type NewChatTarget = 'unset' | 'general' | 'new';

/**
 * Label for the project-picker trigger. `displayName` (a selected project's name) always wins.
 * Non-new-chat callers (flow editor) pass `isNewChatContext=false` and get the neutral label.
 */
export function projectTriggerLabel(
  displayName: string,
  isNewChatContext: boolean,
  target: NewChatTarget,
): string {
  if (displayName) return displayName;
  if (!isNewChatContext) return 'Select project';
  if (target === 'general') return 'General chat';
  if (target === 'new') return 'New project';
  return 'Open project';
}

/**
 * Whether sending should scaffold a new Frink-managed project. Only true when no existing project
 * is selected AND the user explicitly chose "New project" — general/unset never scaffold.
 */
export function shouldScaffoldNewProject(
  hasSelectedProject: boolean,
  target: NewChatTarget,
): boolean {
  return !hasSelectedProject && target === 'new';
}
