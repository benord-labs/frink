/* eslint-disable project-structure/folder-structure */

/**
 * Pure decision for syncing `selectedProjectAtom` when the active chat changes (single-pane).
 *
 * Splitting the branch logic out of the effect keeps it unit-testable and documents the three
 * terminal states. The key correctness point is the cold-start race: the project list (which
 * carries git metadata — and thus the project's icon) loads asynchronously. If the list has not
 * resolved yet we must DEFER rather than commit a git-less/absent result, otherwise the sync guard
 * (keyed on projectId) would block the re-sync that fixes the icon once the list arrives.
 */

import type { SelectedProject } from '../atoms';

type ProjectGitFields = {
  gitRemoteUrl?: string | null;
  gitProvider?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
};

type LocalProjectInput = { id: string; name: string; path: string } & ProjectGitFields;

export type ChatProjectSyncDecision =
  | { kind: 'clear' }
  | { kind: 'defer' }
  | { kind: 'set'; project: NonNullable<SelectedProject> };

function toSelected(p: LocalProjectInput): NonNullable<SelectedProject> {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    gitRemoteUrl: p.gitRemoteUrl,
    gitProvider: (p.gitProvider ?? null) as 'github' | 'gitlab' | 'bitbucket' | null,
    gitOwner: p.gitOwner,
    gitRepo: p.gitRepo,
  };
}

export function resolveChatProjectSync(params: {
  projectId: string | null;
  /** False while the project list query is still loading (data === undefined). */
  projectsLoaded: boolean;
  /** Local project found via projectsMap, if any. */
  resolvedProject: LocalProjectInput | undefined;
  /** The chat's own project as returned by chats.get (local-first: always local, carries git). */
  chatProject: LocalProjectInput | null | undefined;
}): ChatProjectSyncDecision {
  const { projectId, projectsLoaded, resolvedProject, chatProject } = params;

  if (!projectId) return { kind: 'clear' };
  if (resolvedProject) return { kind: 'set', project: toSelected(resolvedProject) };

  // Miss. While the list is still loading this is a timing miss — defer so the effect re-runs
  // (and resolves via projectsMap) once the list arrives. Committing here would strand the icon.
  if (!projectsLoaded) return { kind: 'defer' };

  // Loaded but the project is not in the local list (deleted / stale id): reflect the chat's own
  // project so the UI updates; downstream validation clears it if it is genuinely gone.
  if (chatProject) return { kind: 'set', project: toSelected(chatProject) };
  return { kind: 'clear' };
}
