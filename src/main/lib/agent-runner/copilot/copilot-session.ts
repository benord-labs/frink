import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  CopilotSession,
  GetAuthStatusResponse,
  GetStatusResponse,
  ManagedSettingsResolvedData,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import log from 'electron-log';
import type { createCopilotGate } from './copilot-gate';
import type { CopilotTools } from './copilot-tools';

/** The parts of a Copilot session the checks read. */
export type CheckedSession = {
  rpc: {
    permissions: Pick<CopilotSession['rpc']['permissions'], 'getMode'>;
    mode: Pick<CopilotSession['rpc']['mode'], 'get' | 'set'>;
  };
  disconnect(): Promise<void>;
};

/** The parts of a Copilot client a turn opens its session with. */
export type CopilotSessionHost<Session extends CheckedSession> = {
  getStatus(): Promise<GetStatusResponse>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<Session>;
};

type Versions = { floor: string; below: string };
type Refused = { ok: false; reason: string };

const PROTOCOL_VERSION = 3;
const MANAGED_WAIT_MS = 5_000;
const VERSION = /^\d+\.\d+\.\d+$/;
const KEPT_STATE = /^(?:session-state|session-store\.db.*)$/;

const SIGNED_OUT =
  "GitHub Copilot isn't signed in. Open Terminal, run `copilot login`, finish in your browser, then try again.";
const ENTERPRISE_SERVER =
  "Frink can't run GitHub Copilot for GitHub Enterprise Server accounts yet.";
const MANAGED =
  "Your organisation or device manages GitHub Copilot's settings, so Frink can't run it safely.";
const NOT_APPLIED =
  "GitHub Copilot didn't confirm Frink's safety settings, so Frink didn't start it.";
const NOT_MANUAL = 'GitHub Copilot started without asking before changes, so Frink stopped it.';
const NO_PLAN =
  "GitHub Copilot couldn't turn Plan mode on or off as asked, so Frink didn't send your message.";
const NEW_PROTOCOL =
  "This GitHub Copilot release talks to apps in a way Frink doesn't support yet.";

// Approve-all and Copilot's own assisted approval stay off; the SDK passes this to Copilot as is.
const FRINK_POLICY = {
  permissions: { disableBypassPermissionsMode: 'disable', disableAssistedPermissionsMode: true },
};

/** The one set of options every Copilot session is opened or resumed with. */
export function copilotSessionOptions(input: {
  cwd: string;
  configDirectory: string;
  tools: CopilotTools;
  gate: ReturnType<typeof createCopilotGate>;
  onEvent: (event: SessionEvent) => void;
  model?: string;
  reasoningEffort?: SessionConfig['reasoningEffort'];
}): SessionConfig {
  return {
    workingDirectory: input.cwd,
    configDirectory: input.configDirectory,
    availableTools: Object.keys(input.tools),
    enableFileHooks: false,
    enableConfigDiscovery: false,
    remoteSession: 'off',
    managedSettings: FRINK_POLICY,
    streaming: true,
    hooks: { onPreToolUse: input.gate.onPreToolUse },
    // Frink decides in its hook; anything that still reaches Copilot's own check is refused.
    onPermissionRequest: () => ({ kind: 'reject', feedback: 'Frink decides before each step.' }),
    onEvent: input.onEvent,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  };
}

/** Why a session's managed settings are not Frink's own policy alone, if they are not. */
export function managedLayerProblem(data: ManagedSettingsResolvedData): string | undefined {
  if (data.serverManaged || data.deviceManaged || data.policyHelperManaged) return MANAGED;
  // An unreadable policy or a missing policy-helper layer may hide an organisation layer.
  if (data.failClosed || data.policyHelperManaged === undefined) return NOT_APPLIED;
  if (!data.clientManaged || !data.bypassPermissionsDisabled) return NOT_APPLIED;
  return undefined;
}

const byVersion = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

function versionProblem(status: GetStatusResponse, { floor, below }: Versions) {
  const { version, protocolVersion } = status;
  if (protocolVersion !== PROTOCOL_VERSION) return NEW_PROTOCOL;
  if (VERSION.test(version) && byVersion(version, floor) >= 0 && byVersion(version, below) < 0) {
    return undefined;
  }
  const minor = floor.split('.').slice(0, 2).join('.');
  return `Frink has checked GitHub Copilot CLI ${floor} and later ${minor} releases. You have ${version}.`;
}

/** Wraps a session's events so any failing managed-settings report while it opens is kept. */
function watchManagedSettings(options: SessionConfig) {
  let reported = false;
  let failure: string | undefined;
  let settle = () => {};
  const firstReport = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const { onEvent } = options;
  return {
    options: {
      ...options,
      onEvent: (event: SessionEvent) => {
        if (event.type === 'session.managed_settings_resolved') {
          reported = true;
          failure ??= managedLayerProblem(event.data);
          settle();
        }
        onEvent?.(event);
      },
    },
    async waitForReport() {
      const timer = setTimeout(settle, MANAGED_WAIT_MS);
      await firstReport;
      clearTimeout(timer);
    },
    problem: () => failure ?? (reported ? undefined : NOT_APPLIED),
  };
}

// Each attempt gets its own watch, so a failed resume's report never vouches for the new session.
async function openSession<Session extends CheckedSession>(
  client: CopilotSessionHost<Session>,
  options: SessionConfig,
  resumeSessionId: string | undefined,
) {
  if (resumeSessionId) {
    const watch = watchManagedSettings(options);
    try {
      const session = await client.resumeSession(resumeSessionId, watch.options);
      return { session, resumed: true, watch };
    } catch (error) {
      log.warn('[Copilot] Could not resume the earlier session; starting a new one', error);
    }
  }
  const watch = watchManagedSettings(options);
  return { session: await client.createSession(watch.options), resumed: false, watch };
}

/** True for an account on github.com, however Copilot writes the host. */
function onGitHubCom(host: string): boolean {
  try {
    const url = new URL(host.includes('://') ? host : `https://${host}`);
    return url.protocol === 'https:' && url.host === 'github.com';
  } catch {
    return false;
  }
}

/** Closes a session Frink refused; stopping the turn's client still ends it if this fails. */
async function closeRefused(session: CheckedSession) {
  await session
    .disconnect()
    .catch((error) => log.warn('[Copilot] Could not close a session', error));
}

// Copilot keeps a resumed session's mode, so the asked mode is set every time, Plan or not.
async function modeProblem(session: CheckedSession, plan: boolean) {
  if ((await session.rpc.permissions.getMode()).mode !== 'manual') return NOT_MANUAL;
  const wanted = plan ? 'plan' : 'interactive';
  const applied = await session.rpc.mode
    .set({ mode: wanted })
    .then(() => session.rpc.mode.get())
    .then((mode) => mode === wanted)
    .catch(() => false);
  return applied ? undefined : NO_PLAN;
}

/**
 * Opens or resumes a session only when Copilot's version, sign-in, managed settings and
 * permission mode all pass, and sets Plan mode on or off as asked.
 */
export async function openCheckedSession<Session extends CheckedSession>(
  client: CopilotSessionHost<Session>,
  input: { options: SessionConfig; resumeSessionId?: string; plan: boolean; versions: Versions },
): Promise<{ ok: true; session: Session; resumed: boolean } | Refused> {
  const refuse = (reason: string): Refused => ({ ok: false, reason });
  const outdated = versionProblem(await client.getStatus(), input.versions);
  if (outdated) return refuse(outdated);
  const { isAuthenticated, host } = await client.getAuthStatus();
  if (!isAuthenticated) return refuse(SIGNED_OUT);
  if (host !== undefined && !onGitHubCom(host)) return refuse(ENTERPRISE_SERVER);

  const { session, resumed, watch } = await openSession(
    client,
    input.options,
    input.resumeSessionId,
  );
  let problem: string | undefined;
  try {
    await watch.waitForReport();
    problem = watch.problem() ?? (await modeProblem(session, input.plan)) ?? watch.problem();
  } catch (error) {
    await closeRefused(session);
    throw error;
  }
  if (!problem) return { ok: true, session, resumed };
  await closeRefused(session);
  return refuse(problem);
}

/** Creates Frink's private Copilot folder and clears everything in it but saved sessions. */
export async function prepareConfigDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const stale = (await readdir(dir)).filter((name) => !KEPT_STATE.test(name));
  await Promise.all(
    stale.map((name) => rm(path.join(dir, name), { recursive: true, force: true })),
  );
}
