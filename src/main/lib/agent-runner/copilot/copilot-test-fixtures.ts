import type {
  GetAuthStatusResponse,
  GetStatusResponse,
  ManagedSettingsResolvedData,
  PermissionMode,
  SessionConfigBase,
  SessionMode,
} from '@github/copilot-sdk';
import type { CheckedSession, CopilotSessionHost } from './copilot-session';

/** What a session reports when only Frink's own policy applies. */
export const CLIENT_ONLY_POLICY: ManagedSettingsResolvedData = {
  bypassPermissionsDisabled: true,
  clientManaged: true,
  deviceManaged: false,
  failClosed: false,
  managedKeys: ['permissions'],
  policyHelperManaged: false,
  serverManaged: false,
  source: 'client',
};

type FakeCopilotSetup = {
  status?: GetStatusResponse;
  auth?: GetAuthStatusResponse;
  /** The managed-settings report sent while the session opens; null sends none. */
  managed?: ManagedSettingsResolvedData | null;
  /** A report sent while Frink checks the permission mode. */
  managedLater?: ManagedSettingsResolvedData;
  permissionMode?: PermissionMode;
  /** The mode a session opens in; Copilot keeps a resumed session's mode. */
  mode?: SessionMode;
  /** The resume reports Frink's policy, then fails. */
  resumeFails?: boolean;
  planFails?: boolean;
};

type OpenedSession = { how: 'create' | 'resume'; sessionId?: string; config: SessionConfigBase };

/** A Copilot client double that records how each session was opened. */
export function fakeCopilotClient(setup: FakeCopilotSetup = {}) {
  const opened: OpenedSession[] = [];
  let disconnects = 0;
  let mode: SessionMode = setup.mode ?? 'interactive';
  let lastConfig: SessionConfigBase | undefined;
  const report = (config: SessionConfigBase | undefined, data: ManagedSettingsResolvedData) =>
    config?.onEvent?.({
      type: 'session.managed_settings_resolved',
      data,
      ephemeral: true,
      id: 'managed-event',
      parentId: null,
      timestamp: new Date(0).toISOString(),
    });
  const session: CheckedSession = {
    rpc: {
      permissions: {
        getMode: async () => {
          if (setup.managedLater) report(lastConfig, setup.managedLater);
          return { mode: setup.permissionMode ?? 'manual' };
        },
      },
      mode: {
        get: async () => mode,
        set: async (params) => {
          if (setup.planFails) throw new Error('mode change failed');
          mode = params.mode;
          return { status: 'applied', modelChanged: false };
        },
      },
    },
    disconnect: async () => {
      disconnects += 1;
    },
  };
  const open = (config: SessionConfigBase) => {
    lastConfig = config;
    const data = setup.managed === undefined ? CLIENT_ONLY_POLICY : setup.managed;
    if (data) report(config, data);
    return session;
  };
  const client: CopilotSessionHost<CheckedSession> = {
    getStatus: async () => setup.status ?? { version: '1.0.97', protocolVersion: 3 },
    getAuthStatus: async () =>
      setup.auth ?? { isAuthenticated: true, authType: 'user', host: 'https://github.com' },
    createSession: async (config) => {
      opened.push({ how: 'create', config });
      return open(config);
    },
    resumeSession: async (sessionId, config) => {
      opened.push({ how: 'resume', sessionId, config });
      if (setup.resumeFails) {
        report(config, CLIENT_ONLY_POLICY);
        throw new Error('Session not found');
      }
      return open(config);
    },
  };
  return { client, session, opened, disconnects: () => disconnects };
}
