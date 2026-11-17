import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { claudeMemoryProjectRoot } from '../../claude/auto-memory';
import { getMultiProjectContext } from '../../multi-project-prompt';
import { resolvePermissionProjectPath } from '../../permissions';

type WorkspaceProject = { id: string; name: string; path: string };
type WorkspaceChat = { worktreePath?: string | null; branch?: string | null };

function physicalPath(dir: string): string {
  try {
    return fs.realpathSync.native(dir).normalize('NFC');
  } catch {
    return path.resolve(dir).normalize('NFC');
  }
}

/** The main checkout a Frink-managed worktree belongs to, which Claude reads project settings,
 * hooks and `.claude` config from, as Claude Code does in its own worktree sessions. */
export function claudeProjectConfigRoot(
  worktreePath: string,
  permissionProjectPath: string,
): string | undefined {
  if (permissionProjectPath === worktreePath) return undefined;
  const root = claudeMemoryProjectRoot(worktreePath);
  if (root !== physicalPath(worktreePath)) return root;
  log.warn(`[Socket Executor] Worktree has no main checkout to read config from: ${worktreePath}`);
  return undefined;
}

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
  let projectConfigRoot: string | undefined;
  const worktreePath = folder ? chat?.worktreePath : null;
  if (worktreePath && fs.existsSync(worktreePath)) {
    projectPath = worktreePath;
    permissionProjectPath = resolvePermissionProjectPath(worktreePath);
    projectConfigRoot = claudeProjectConfigRoot(worktreePath, permissionProjectPath);
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
  // Every chat gets the dynamic-chat MCP from getMultiProjectContext; plan mode, which cannot
  // proceed without it, retries once if that start failed.
  let dynamicChatMcpUrl = multiProject.dynamicChatMcpUrl;
  if (mode === 'plan' && !dynamicChatMcpUrl) {
    const { getOrStartDynamicChatMcpUrl } = await import('../../mcp/dynamic-chat-server');
    dynamicChatMcpUrl = await getOrStartDynamicChatMcpUrl();
  }
  return {
    projectPath,
    permissionProjectPath,
    projectConfigRoot,
    multiProjectPrefix: multiProject.promptPrefix,
    dynamicChatMcpUrl,
  };
}
