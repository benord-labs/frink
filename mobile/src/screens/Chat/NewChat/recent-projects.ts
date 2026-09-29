import type { MobileResponses } from '../../../../../src/shared/types/remote/mobile';

type Project = MobileResponses['projects'][number];

/** Projects with the most recently active chat first; the rest keep the computer's order.
 *  `chats` arrives newest first, so a project's rank is where its latest chat appears. */
export function recentProjectsFirst(
  projects: Project[],
  chats: MobileResponses['chats']['items'] = [],
): Project[] {
  const rank = new Map<string, number>();
  for (const chat of chats)
    if (chat.projectId && !rank.has(chat.projectId)) rank.set(chat.projectId, rank.size);
  const order = (project: Project) => rank.get(project.id) ?? Infinity;
  return [...projects].sort((a, b) => order(a) - order(b));
}
