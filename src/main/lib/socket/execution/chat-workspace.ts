import fs from 'node:fs';
import os from 'node:os';
import log from 'electron-log';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { getMultiProjectContext } from '../../multi-project-prompt';
import { resolvePermissionProjectPath } from '../../permissions';

type WorkspaceProject = { id: string; name: string; path: string };
type WorkspaceChat = { worktreePath?: string | null; branch?: string | null };

/** Where a chat's agent runs and the Frink context it gets, shared by a send and a pre-warm so both
 * spawn the same CLI: the chat's worktree while on disk, else the project folder, else home. */
export async function resolveChatWorkspace(
  project: WorkspaceProject | null,
  chat: WorkspaceChat | null | undefined,
  mode: ChatMode,
) {
  // General chats, virtual folders and projects missing on disk run in home.
  const folder = project && !project.path.startsWith('virtual://') ? project : null;
  let projectPath = folder && fs.existsSync(folder.path) ? folder.path : os.homedir();
  let permissionProjectPath = projectPath;
  const worktreePath = folder ? chat?.worktreePath : null;
  if (worktreePath && fs.existsSync(worktreePath)) {
    projectPath = worktreePath;
    permissionProjectPath = resolvePermissionProjectPath(worktreePath);
  } else if (worktreePath) {
    log.warn(`[Socket Executor] Chat worktree missing on disk: ${worktreePath}`);
  }
  log.info(`[Socket Executor] Chat cwd ${projectPath} (permissions ${permissionProjectPath})`);
  const multiProject = await getMultiProjectContext(
    folder
      ? {
          id: folder.id,
          name: folder.name,
          path: folder.path,
          worktreePath: worktreePath ?? null,
          branch: chat?.branch ?? null,
        }
      : undefined,
  );
  // Plan mode always mounts the dynamic-chat MCP; otherwise only a multi-project chat does.
  let dynamicChatMcpUrl = multiProject.dynamicChatMcpUrl;
  if (mode === 'plan' && !dynamicChatMcpUrl) {
    const { getOrStartDynamicChatMcpUrl } = await import('../../mcp/dynamic-chat-server');
    dynamicChatMcpUrl = await getOrStartDynamicChatMcpUrl();
  }
  return {
    projectPath,
    permissionProjectPath,
    multiProjectPrefix: multiProject.promptPrefix,
    dynamicChatMcpUrl,
  };
}
