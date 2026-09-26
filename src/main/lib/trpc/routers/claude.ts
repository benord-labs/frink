import { z } from 'zod';
import {
  clearPendingApprovals,
  resolvePendingToolApproval,
} from '../../claude/ask-user-question-approval';
import { getProjectMcpServers, readClaudeConfig } from '../../claude-config';
import { getMcpAuthStatus, startMcpOAuth } from '../../mcp-auth';
import { publicProcedure, router } from '../index';
import { getAllMcpConfigHandler, getServerStatusFromConfig } from './claude-mcp-config';

// Active sessions for cancellation (used by the cancel / isActive procedures).
const activeSessions = new Map<string, AbortController>();

export const claudeRouter = router({
  /**
   * Get MCP servers configuration for a project
   * This allows showing MCP servers in UI before starting a chat session
   * NOTE: Does NOT fetch OAuth metadata here - that's done lazily when user clicks Auth
   */
  getMcpConfig: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }) => {
      try {
        const config = await readClaudeConfig();
        const projectMcpServers = getProjectMcpServers(config, input.projectPath);

        if (!projectMcpServers) {
          return { mcpServers: [], projectPath: input.projectPath };
        }

        // Convert to array format - determine status from config (no caching)
        const mcpServers = Object.entries(projectMcpServers).map(([name, serverConfig]) => {
          const configObj = serverConfig as Record<string, unknown>;
          const status = getServerStatusFromConfig(configObj);
          const hasUrl = !!configObj.url;

          return {
            name,
            status,
            config: { ...configObj, _hasUrl: hasUrl },
          };
        });

        return { mcpServers, projectPath: input.projectPath };
      } catch (error) {
        return { mcpServers: [], projectPath: input.projectPath, error: String(error) };
      }
    }),

  /**
   * Get ALL MCP servers configuration (global + all projects)
   * Returns grouped data for display in settings
   */
  getAllMcpConfig: publicProcedure.query(async () => getAllMcpConfigHandler()),

  /**
   * Cancel active session
   */
  cancel: publicProcedure.input(z.object({ subChatId: z.string() })).mutation(({ input }) => {
    const controller = activeSessions.get(input.subChatId);
    if (controller) {
      controller.abort();
      activeSessions.delete(input.subChatId);
      clearPendingApprovals('Session cancelled.', input.subChatId);
    }
    return { cancelled: !!controller };
  }),

  /**
   * Check if session is active
   */
  isActive: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .query(({ input }) => activeSessions.has(input.subChatId)),
  respondToolApproval: publicProcedure
    .input(
      z.object({
        toolUseId: z.string(),
        approved: z.boolean(),
        message: z.string().optional(),
        updatedInput: z.unknown().optional(),
      }),
    )
    .mutation(({ input }) => {
      return {
        ok: resolvePendingToolApproval(input.toolUseId, {
          approved: input.approved,
          message: input.message,
          updatedInput: input.updatedInput,
        }),
      };
    }),

  /**
   * Start MCP OAuth flow for a server
   * Fetches OAuth metadata internally when needed
   */
  startMcpOAuth: publicProcedure
    .input(
      z.object({
        serverName: z.string(),
        projectPath: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      return startMcpOAuth(input.serverName, input.projectPath);
    }),

  /**
   * Get MCP auth status for a server
   */
  getMcpAuthStatus: publicProcedure
    .input(
      z.object({
        serverName: z.string(),
        projectPath: z.string(),
      }),
    )
    .query(async ({ input }) => {
      return getMcpAuthStatus(input.serverName, input.projectPath);
    }),
});
