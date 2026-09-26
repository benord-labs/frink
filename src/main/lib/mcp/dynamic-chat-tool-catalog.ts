import { TASK_SIGNAL_TOOL } from '../trpc/routers/frink-task-signal';

export const CODEX_TASK_STOP_GUARD_TOOL_NAME = 'frink_task_stop_guard';

const BASE_TOOLS = [
  {
    name: 'searchProjects',
    description:
      'Search projects by keywords matched across name, description, and path (every word must appear; e.g. "frink desktop", "mobile"). Empty query returns all. Returns matching projects with id, name, path, description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Space-separated keywords; every word must match' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetchAllProjects',
    description: 'List all projects available on this machine.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  TASK_SIGNAL_TOOL,
  {
    name: 'requestSwitchProject',
    description:
      'Move this chat to a different project. The user must approve. On success, the runtime performs an execution handoff and resumes in the new project context with the correct working directory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID from searchProjects or fetchAllProjects',
        },
        worktree_path: {
          type: 'string',
          description: 'Optional absolute worktree path to target a specific chat in the project',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'frink_navigation_context',
    description:
      "Read the chat's current project-worktree context (with live git branch) plus its persistent `history` of previously-visited projects (each entry has project name, worktree path, and live branch). `origin` is the first entry in `history` (the project the chat earliest LEFT), or a snapshot of `current` if the chat has never moved; for forked chats it reflects the source chat's lineage origin since fork inherits `history`. Moving the chat back to any projectId in `history` — including `origin.projectId` — auto-restores the saved worktree.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

export function getRuntimeBaseTools(taskSignalEnabled?: boolean) {
  return taskSignalEnabled === false
    ? BASE_TOOLS.filter((tool) => tool.name !== 'frink_task_signal')
    : BASE_TOOLS;
}
