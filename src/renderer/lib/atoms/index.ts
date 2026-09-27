import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

export {
  type ActiveOverlay,
  activeOverlayAtom,
  agentsSettingsDialogOpenAtom,
  exitTransientDestinationForNavigationAtom,
  flowEditorDirtyAtom,
  flowsSelectedFlowIdAtom,
  focusAgentChatAtom,
  leaveOverlayStackForChatSurfaceAtom,
  navigateToAgentChatAtom,
} from './agent-navigation-atoms';
// ============================================
// RE-EXPORT FROM FEATURES/AGENTS/ATOMS (source of truth)
// ============================================

export {
  agentsSidebarOpenAtom,
  agentsSidebarWidthAtom,
  diffPanelLayoutAtom,
  filteredDiffFilesAtomFamily,
  filteredSubChatIdAtomFamily,
  focusedDiffFileAtomFamily,
  subChatFilesAtom,
} from '../../features/agents/atoms';

// ============================================
// DIALOG ATOMS (unique to lib/atoms)
// ============================================

// Settings dialog
export type SettingsTab =
  | 'usage'
  | 'workqueue'
  | 'permissions'
  | 'appearance'
  | 'preferences'
  | 'mobile'
  | 'models'
  | 'skills'
  | 'agents'
  | 'hooks'
  | 'mcp'
  | 'worktrees'
  | 'integrations'
  | 'debug'
  | 'keyboard'
  | `project-${string}`; // Dynamic project tabs
export const agentsSettingsDialogActiveTabAtom = atom<SettingsTab>('preferences');

// Preferences - Extended Thinking (toggled from the model picker header)
// When enabled, Claude will use extended thinking for deeper reasoning. Default on for new installs.
export const extendedThinkingEnabledAtom = atomWithStorage<boolean>(
  'preferences:extended-thinking-enabled',
  true,
  undefined,
  { getOnInit: true },
);

/** Hidden model family ids (`familyId`) — chat pickers filter; triggers/flows stay unfiltered. */
export const hiddenModelsAtom = atomWithStorage<string[]>('models:hidden', [], undefined, {
  getOnInit: true,
});

// Preferences - Sound Notifications
// When enabled, play a sound when agent completes work (if not viewing the chat)
export const soundNotificationsEnabledAtom = atomWithStorage<boolean>(
  'preferences:sound-notifications-enabled',
  true,
  undefined,
  { getOnInit: true },
);

// Preferences - Desktop Notifications
// When enabled, show a native notification when a turn completes while the window is unfocused
export const desktopNotificationsEnabledAtom = atomWithStorage<boolean>(
  'preferences:desktop-notifications-enabled',
  true,
  undefined,
  { getOnInit: true },
);

// Preferences - Prompt Cache Timer
// When enabled, the chat's workspace row counts down how long Claude's prompt cache stays warm
export const promptCacheTimerEnabledAtom = atomWithStorage<boolean>(
  'preferences:prompt-cache-timer-enabled',
  true,
  undefined,
  { getOnInit: true },
);

// Preferences - Analytics Opt-out
// When true, user has opted out of analytics tracking
export const analyticsOptOutAtom = atomWithStorage<boolean>(
  'preferences:analytics-opt-out',
  false, // Default to opt-in (false means not opted out)
  undefined,
  { getOnInit: true },
);

// ============================================
// CUSTOM HOTKEYS CONFIGURATION
// ============================================

import type { CustomHotkeysConfig } from '../hotkeys/types';

export type { CustomHotkeysConfig };

/**
 * Custom hotkey overrides storage
 * Maps action IDs to custom hotkey strings (or null for default)
 */
export const customHotkeysAtom = atomWithStorage<CustomHotkeysConfig>(
  'preferences:custom-hotkeys',
  { version: 1, bindings: {} },
  undefined,
  { getOnInit: true },
);

// ============================================
// UPDATE ATOMS
// ============================================

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'pending-restart'
  | 'error';

export type UpdateState = {
  status: UpdateStatus;
  version?: string;
  progress?: number; // 0-100
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
};

export const updateStateAtom = atom<UpdateState>({ status: 'idle' });

// Track if app was just updated (to show "What's New" banner)
// This is set to true when app launches with a new version, reset when user dismisses
export const justUpdatedAtom = atom<boolean>(false);

// Store the version that triggered the "just updated" state
export const justUpdatedVersionAtom = atom<string | null>(null);

// ============================================
// DESKTOP/FULLSCREEN STATE ATOMS
// ============================================

// Whether app is running in Electron desktop environment
export const isDesktopAtom = atom<boolean>(false);

// Fullscreen state - null means not initialized yet
// null = not yet loaded, false = not fullscreen, true = fullscreen
export const isFullscreenAtom = atom<boolean | null>(null);

// ============================================
// ONBOARDING ATOMS
// ============================================

// Settings → Connect Claude account flow state.
// Controls whether ConnectClaudeAccountPage is shown.
export const anthropicOnboardingCompletedAtom = atomWithStorage<boolean>(
  'onboarding:anthropic-completed',
  false,
  undefined,
  { getOnInit: true },
);

export type PendingAccountAuthState = {
  accountId?: string;
  accountLabel: string;
  mode: 'add' | 'reauth';
  returnToSettings?: boolean;
  /** Which connect page to route to. Absent/undefined = Claude (backward-compatible). */
  provider?: 'claude-code' | 'codex';
};

// Track pending Claude/Codex account connect/reconnect flow from Settings.
// null = normal app flow
// { mode: 'add' } = brand-new passthrough connect
// { mode: 'reauth' } = reconnect an existing passthrough (e.g. signed out of the CLI)
// { provider: 'codex' } = route to the Codex connect page instead of Claude
export const pendingAccountAuthAtom = atom<PendingAccountAuthState | null>(null);

// ============================================
// SESSION INFO ATOMS (MCP, Plugins, Tools)
// ============================================

type MCPServerStatus = 'connected' | 'failed' | 'pending' | 'needs-auth';

export type MCPServer = {
  name: string;
  status: MCPServerStatus;
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
};

export type SessionInfo = {
  tools: string[];
  mcpServers: MCPServer[];
  plugins: { name: string; path: string }[];
  skills: string[];
};

// Session info from SDK init message
// Contains MCP servers, plugins, available tools, and skills
// Persisted to localStorage so MCP tools are visible after page refresh
// Updated when a new chat session starts
export const sessionInfoAtom = atomWithStorage<SessionInfo | null>(
  'frink-session-info',
  null,
  undefined,
  { getOnInit: true },
);

// ============================================
// DEV TOOLS UNLOCK (Hidden feature)
// ============================================

// DevTools unlock state (hidden feature - click Beta tab 5 times to enable)
// Persisted per-session only (not in localStorage for security)
export const devToolsUnlockedAtom = atom<boolean>(false);
