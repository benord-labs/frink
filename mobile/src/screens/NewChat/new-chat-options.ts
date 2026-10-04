import type { MobileProject } from '@frink/shared/types/remote/mobile';
import type { NewChatPreferences } from '../../lib/preferences';

/** Once published, mode changes go through setMode; an unpublished create must be retired. */
export function creationChoiceChanged(
  previous: NewChatPreferences | null,
  next: NewChatPreferences,
  published: boolean,
) {
  if (!previous) return true;
  return (
    previous.projectId !== next.projectId ||
    previous.useWorktree !== next.useWorktree ||
    (!published && previous.mode !== next.mode)
  );
}

/** One plain line per choice, for people who have never heard of a git worktree. */
export const WORK_HELP = {
  worktree: 'Worktree: a separate copy, safe to experiment.',
  local: 'Local: works directly in your project folder.',
} as const;
export const PLAN_HELP = 'Plan: Frink writes a plan for you to review before it changes anything.';

/** Why chats can't start: the phone only relays, so the Mac app has to be open to run them. */
export const NOT_READY = 'Open Frink on your Mac to run chats.';

/** The picker gets a search field once the list is longer than a glance. */
export const PROJECT_SEARCH_THRESHOLD = 6;

/** Projects whose name contains the query, keeping the computer's most-recent-first order. */
export function filterProjects(projects: MobileProject[], query: string): MobileProject[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return projects;
  return projects.filter((project) => project.name.toLocaleLowerCase().includes(needle));
}

/**
 * The project to start in: the one asked for, else the last one used if it still exists, else the
 * most recently active one (the list comes most-recent-first), so Send never waits on a silent pick.
 */
export function chosenProject(
  projects: MobileProject[] | undefined,
  id: string | null,
): MobileProject | undefined {
  return projects?.find((project) => project.id === id) ?? projects?.[0];
}
