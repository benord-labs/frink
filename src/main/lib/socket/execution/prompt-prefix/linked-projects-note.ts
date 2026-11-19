import { isCompactCommand } from '../../../../../shared/commands/expand-slash-command';
import { type ComposerNote, notePath } from './composer-context';

/**
 * Tells the agent which projects are linked to the chat and where they are, so it reads them in
 * place by full path. Sent with every turn, on the same channel as the composer's notes. None when
 * no project is linked, or for a `/compact`, which goes out bare (see isCompactCommand).
 */
export function linkedProjectsNote(
  projects: Array<{ name: string; path: string }>,
  cwd: string,
  prompt: string,
): ComposerNote[] {
  if (projects.length === 0 || isCompactCommand(prompt)) return [];
  const list = projects.map((project) => `${notePath(project.name)} — ${notePath(project.path)}`);
  const text = `Projects linked to this chat (you can read their files by full path; your working folder stays ${notePath(cwd)}): ${list.join('; ')}.`;
  return [{ kind: 'linked_projects', text }];
}
