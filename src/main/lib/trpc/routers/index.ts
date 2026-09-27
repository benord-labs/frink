import type { BrowserWindow } from 'electron';
import { createGitRouter } from '../../git';
import { router } from '../index';
import { agentsRouter } from './agents';
import { chatsRouter } from './chats';
import { claudeRouter } from './claude';
import { claudeCodeRouter } from './claude-code';
import { claudeSettingsRouter } from './claude-settings';
import { commandsRouter } from './commands';
import { customNodesRouter } from './custom-nodes';
import { debugRouter } from './debug';
import { externalRouter } from './external';
import { filesRouter } from './files';
import { flowsRouter } from './flows';
import { hooksRouter } from './hooks';
import { integrationsRouter } from './integrations';
import { mcpRouter } from './mcp';
import { mobileRouter } from './mobile';
import { permissionsRouter } from './permissions';
import { pluginsRouter } from './plugins';
import { projectsRouter } from './projects';
import { skillsRouter } from './skills';
import { socketRouter } from './socket';
import { tasksRouter } from './tasks';
import { terminalRouter } from './terminal';
import { triggerBindingsRouter } from './trigger-bindings';
import { triggerRulesRouter } from './trigger-rules';
import { triggerSetupRouter } from './trigger-setup';
import { usageRouter } from './usage';
import { usageHistoryRouter } from './usage-history';
import { worktreeConfigRouter } from './worktree-config';

/**
 * Create the main app router
 * Uses getter pattern to avoid stale window references
 */
export function createAppRouter(_getWindow: () => BrowserWindow | null) {
  return router({
    projects: projectsRouter,
    chats: chatsRouter,
    claude: claudeRouter,
    claudeCode: claudeCodeRouter,
    claudeSettings: claudeSettingsRouter,
    terminal: terminalRouter,
    external: externalRouter,
    files: filesRouter,
    flows: flowsRouter,
    customNodes: customNodesRouter,
    debug: debugRouter,
    skills: skillsRouter,
    agents: agentsRouter,
    hooks: hooksRouter,
    worktreeConfig: worktreeConfigRouter,
    commands: commandsRouter,
    mcp: mcpRouter,
    mobile: mobileRouter,
    permissions: permissionsRouter,
    plugins: pluginsRouter,
    tasks: tasksRouter,
    integrations: integrationsRouter,
    triggerRules: triggerRulesRouter,
    triggerSetup: triggerSetupRouter,
    triggerBindings: triggerBindingsRouter,
    socket: socketRouter,
    usage: usageRouter,
    usageHistory: usageHistoryRouter,
    // Git operations - named "changes" to match Superset API
    changes: createGitRouter(),
  });
}

/**
 * Export the router type for client usage
 */
export type AppRouter = ReturnType<typeof createAppRouter>;
