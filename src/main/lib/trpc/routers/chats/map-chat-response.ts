import type { Chat, Project } from '../../../db/schema';

export type ChatProjectResponse = {
  id: string;
  name: string;
  path: string;
  gitRemoteUrl: string | null;
  gitProvider: 'github' | 'gitlab' | 'bitbucket' | null;
  gitOwner: string | null;
  gitRepo: string | null;
};

/**
 * Project shape returned alongside a chat. Carries the git fields the renderer needs to render
 * the project's icon (GitHub avatar from gitOwner/gitProvider) — see `chat-project-sync.ts`.
 * Shared by `chats.get` and `getSubChat` so the projection lives in one place.
 */
export function mapChatProject(project: Project | null | undefined): ChatProjectResponse | null {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    gitRemoteUrl: project.gitRemoteUrl,
    gitProvider: project.gitProvider as 'github' | 'gitlab' | 'bitbucket' | null,
    gitOwner: project.gitOwner,
    gitRepo: project.gitRepo,
  };
}

/**
 * Map a local SQLite `Chat` row into the renderer-facing chat-response shape.
 * Local Chat is already camelCase + Date, so this is mostly a pass-through with
 * `batchId` filled in as null (local DB doesn't track flow_run batch grouping).
 *
 * createdAt/updatedAt are coerced to non-null because the Drizzle schema applies
 * a `$defaultFn(() => new Date())` to both — the columns are `Date | null` by
 * inference but never null at runtime.
 */
export function mapLocalChatResponse(chat: Chat) {
  return {
    id: chat.id,
    name: chat.name,
    projectId: chat.projectId,
    createdAt: chat.createdAt ?? new Date(),
    updatedAt: chat.updatedAt ?? new Date(),
    archivedAt: chat.archivedAt,
    pinnedAt: chat.pinnedAt,
    worktreePath: chat.worktreePath,
    branch: chat.branch,
    baseBranch: chat.baseBranch,
    prUrl: chat.prUrl,
    prNumber: chat.prNumber,
    taskId: chat.taskId,
    provider: chat.provider,
    batchId: null as string | null,
    // JSON-as-text Record<projectId, worktreePath> — internal; the renderer doesn't render
    // it but the mutation roundtrips it (move resolver reads + writes it).
    worktreeHistory: chat.worktreeHistory,
  };
}
