/**
 * Shared prompt and MCP for multi-project tools (searchProjects, fetchAllProjects, requestSwitchProject).
 * Injected when the user has 2+ projects. Used by both Claude and Codex paths in the executor.
 */

import { dedupeByCodebase } from '../../shared/lib/project-codebase';
import { getDatabase } from './db';
import { listProjects } from './db/repos/projects';
import type { Project } from './db/schema';

const MAX_PROMPT_PROJECTS = 6;
const MAX_SUMMARY_CHARS = 96;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function summarizeProject(project: Project): string {
  const description = project.description?.trim();
  if (!description) {
    return 'No summary provided';
  }
  return truncateText(description.replace(/\s+/g, ' '), MAX_SUMMARY_CHARS);
}

export function buildMultiProjectToolsBlock(projects: Project[]): string {
  return buildMultiProjectToolsBlockWithCurrentContext(projects);
}

type CurrentProjectContext = {
  name: string;
  id: string;
  path: string;
  worktreePath: string | null;
  branch: string | null;
};

function buildCurrentContextBlock(currentProject?: CurrentProjectContext): string {
  if (!currentProject) return '';
  const isWorktree = Boolean(currentProject.worktreePath);
  const effectivePath = currentProject.worktreePath ?? currentProject.path;
  return `<current_context>
You are currently in:
- Project: "${currentProject.name}" (id: ${currentProject.id})
- Path: ${effectivePath}
- Branch: ${currentProject.branch ?? 'unknown'}
- Worktree: ${isWorktree ? 'yes' : 'no'}
</current_context>

`;
}

function buildMultiProjectToolsBlockWithCurrentContext(
  projects: Project[],
  currentProject?: CurrentProjectContext,
): string {
  const dedupedProjects = dedupeByCodebase(
    projects,
    (project) => project.gitRemoteUrl,
    (project) => project.path,
    (project) => project.description,
  );
  const sortedProjects = [...dedupedProjects].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const summarizedProjects = sortedProjects.slice(0, MAX_PROMPT_PROJECTS);
  const hasMoreProjects = sortedProjects.length > summarizedProjects.length;

  const projectLines = summarizedProjects
    .map((project, index) => `${index + 1}. "${project.name}" - ${summarizeProject(project)}`)
    .join('\n');

  const extraLine = hasMoreProjects
    ? `\n${summarizedProjects.length + 1}. (+${sortedProjects.length - summarizedProjects.length} more project(s); use tools for full list)`
    : '';

  const currentContextBlock = buildCurrentContextBlock(currentProject);
  return `${currentContextBlock}<multi_project_tools>
You are in a multi-project workspace. Here are the projects that can be accessed in this session (summarized):

${projectLines}${extraLine}

WHEN A DIFFERENT PROJECT CONTEXT MAY HELP:
- The current issue depends on behavior, data, configuration, or history owned by another project
- You need source-of-truth details maintained in a different project context
- You want to validate whether a problem is local to one project or shared across related projects

TOOLS:
- searchProjects(query) — Find projects by description or name and get detailed results
- fetchAllProjects() — Get the full non-summarized list of accessible projects
- requestSwitchProject(project_id, worktree_path?) — Ask to switch to that project's chat context. Pass worktree_path to target a specific worktree chat
- frink_navigation_context() — Inspect your current/origin project+worktree context and switch trail

Project summaries above are intentionally brief to reduce context usage.
Use searchProjects/fetchAllProjects when you need fuller project metadata.
If a different project context is needed, explain why and then use requestSwitchProject.
When you need to return to a prior worktree, call frink_navigation_context() first and reuse the recorded worktree path.
</multi_project_tools>`;
}

type MultiProjectContext = {
  /** Prompt to prepend when user has 2+ projects (empty string otherwise) */
  promptPrefix: string;
  /** Dynamic chat MCP URL to add for Claude (null if not applicable or unavailable) */
  dynamicChatMcpUrl: string | null;
};

/**
 * Shared helper for Claude and Codex: prompt block + optional MCP URL when user has multiple projects.
 */
export async function getMultiProjectContext(
  currentProject?: CurrentProjectContext,
): Promise<MultiProjectContext> {
  let projects: Project[] = [];
  try {
    projects = await listProjects(getDatabase());
  } catch {
    // leave projects empty — multi-project block silently disables
  }

  if (projects.length < 2) {
    return { promptPrefix: '', dynamicChatMcpUrl: null };
  }

  const { getOrStartDynamicChatMcpUrl } = await import('./mcp/dynamic-chat-server');
  const dynamicChatUrl = await getOrStartDynamicChatMcpUrl();

  return {
    promptPrefix: buildMultiProjectToolsBlockWithCurrentContext(projects, currentProject),
    dynamicChatMcpUrl: dynamicChatUrl ?? null,
  };
}
