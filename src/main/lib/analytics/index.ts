/**
 * PostHog analytics for Frink Desktop. The main process is the only sender: the
 * renderer reports its events over IPC, so one opt-out gate covers every event.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { PostHog } from 'posthog-node';
import type { MessageSentEvent } from '../../../shared/types/analytics';

const INSTALL_ID_FILE = '.install_id';

type AnalyticsClient = Pick<PostHog, 'capture' | 'shutdown'>;

/** What analytics needs from the app it runs in; tests supply their own. */
export type AnalyticsHost = {
  isPackaged: boolean;
  userDataDir: string;
  version: string;
  key: string | undefined;
  createClient: (key: string) => AnalyticsClient;
};

type Session = { host: AnalyticsHost; client: AnalyticsClient; savedInstallId: string };
type Install = { id: string; firstLaunch: boolean };
type EventProperties = Record<string, string | number | boolean>;

// Set by initAnalytics only when this build may send
let session: Session | null = null;
// Nothing is sent until the renderer reports the saved preference
let userOptedOut: boolean = true;
let appOpenTracked: boolean = false;
let install: Install | null = null;
let installSaved: Promise<void> = Promise.resolve();

function electronHost(): AnalyticsHost {
  return {
    isPackaged: app.isPackaged,
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    key: import.meta.env.MAIN_VITE_POSTHOG_KEY,
    createClient: (key) =>
      new PostHog(key, {
        host: import.meta.env.MAIN_VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
        // Flush events every 30 seconds or when 20 events are queued
        flushAt: 20,
        flushInterval: 30000,
      }),
  };
}

/** The id an earlier launch saved, or '' when this install has never sent an event. */
function readSavedInstallId(userDataDir: string): string {
  try {
    return fs.readFileSync(path.join(userDataDir, INSTALL_ID_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * A random id for this install, kept in userData so every event from one machine
 * counts as one anonymous install. No saved id means this is the first launch.
 */
function getInstall({ host, savedInstallId }: Session): Install {
  if (install) return install;

  install = { id: savedInstallId || randomUUID(), firstLaunch: !savedInstallId };
  if (!savedInstallId) {
    // If the write fails the id lasts for this session only
    installSaved = fs.promises
      .writeFile(path.join(host.userDataDir, INSTALL_ID_FILE), install.id)
      .catch(() => {});
  }
  return install;
}

/**
 * Get common properties for all events
 */
function getCommonProperties(version: string) {
  return {
    source: 'desktop', // Unified source for desktop vs web analytics
    app_version: version,
    platform: process.platform,
    arch: process.arch,
    electron_version: process.versions.electron,
    node_version: process.versions.node,
  };
}

/** The session, or null while nothing may leave this machine. */
function activeSession(): Session | null {
  return userOptedOut ? null : session;
}

/**
 * Set opt-out status (called from renderer on launch and when the preference changes).
 * The app-open event waits for the first report, so an opted-out install sends nothing.
 */
export function setOptOut(optedOut: boolean) {
  userOptedOut = optedOut;
  const active = activeSession();
  if (appOpenTracked || !active) return;

  appOpenTracked = true;
  trackAppOpened(active);
}

/**
 * Initialize PostHog for main process. Unpackaged builds and builds without a key
 * get no session, so they send nothing.
 */
export function initAnalytics(host: AnalyticsHost = electronHost()) {
  if (session || !host.isPackaged || !host.key) return;

  session = {
    host,
    client: host.createClient(host.key),
    savedInstallId: readSavedInstallId(host.userDataDir),
  };
}

/**
 * Capture an analytics event
 */
function capture(eventName: string, properties?: EventProperties) {
  const active = activeSession();
  if (!active) return;

  active.client.capture({
    distinctId: getInstall(active).id,
    event: eventName,
    // No location is derived from the request's IP address
    disableGeoip: true,
    properties: {
      ...getCommonProperties(active.host.version),
      ...properties,
    },
  });
}

/**
 * Shutdown PostHog and flush pending events
 */
export async function shutdown() {
  // Cleared first, so nothing is queued behind the final flush and then lost
  const closing = session;
  session = null;
  await installSaved;
  await closing?.client.shutdown();
}

/**
 * Track app opened event
 */
function trackAppOpened(active: Session) {
  const { firstLaunch } = getInstall(active);

  capture('desktop_opened', {
    first_launch: firstLaunch,
  });

  if (firstLaunch) {
    // also fire a separate first_launch event for funnel analysis
    capture('first_launch');
  }
}

/**
 * Track a message sent from the UI, as reported by the renderer through the analytics router
 */
export function trackMessageSent(event: MessageSentEvent) {
  capture('message_sent', {
    workspace_id: event.workspaceId,
    message_length: event.messageLength,
    mode: event.mode,
  });
}

/**
 * Track project opened
 */
export function trackProjectOpened(project: { id: string; hasGitRemote: boolean }) {
  capture('project_opened', {
    project_id: project.id,
    has_git_remote: project.hasGitRemote,
  });
}

/**
 * Track workspace/chat created
 */
export function trackWorkspaceCreated(workspace: {
  id: string;
  projectId: string;
  useWorktree: boolean;
}) {
  capture('workspace_created', {
    workspace_id: workspace.id,
    project_id: workspace.projectId,
    use_worktree: workspace.useWorktree,
  });
}

/**
 * Track workspace archived
 */
export function trackWorkspaceArchived(workspaceId: string) {
  capture('workspace_archived', {
    workspace_id: workspaceId,
  });
}

/**
 * Track workspace deleted
 */
export function trackWorkspaceDeleted(workspaceId: string) {
  capture('workspace_deleted', {
    workspace_id: workspaceId,
  });
}

/**
 * Track PR created
 */
export function trackPRCreated(data: { workspaceId: string; prNumber: number }) {
  capture('pr_created', {
    workspace_id: data.workspaceId,
    pr_number: data.prNumber,
  });
}
