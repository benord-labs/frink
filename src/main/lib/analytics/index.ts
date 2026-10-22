/**
 * PostHog analytics for Frink Desktop. The main process is the only sender: the
 * renderer reports its events over IPC, so one opt-out gate covers every event.
 */

import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { PostHog } from 'posthog-node';
import type { MessageSentEvent } from '../../../shared/types/analytics';
import { subscribeSessionCompletions } from '../socket/streaming/live-stream/completion-events';

const INSTALL_ID_FILE = '.install_id';
const RETURN_AFTER_MS = 4 * 60 * 60 * 1000;

type AnalyticsClient = Pick<PostHog, 'capture' | 'shutdown'>;

/** What analytics needs from the app it runs in; tests supply their own. */
export type AnalyticsHost = {
  isPackaged: boolean;
  userDataDir: string;
  version: string;
  key: string | undefined;
  /** FRINK_DISABLE_USAGE_ANALYTICS as set for this launch */
  disableUsageAnalytics: string | undefined;
  createClient: (key: string) => AnalyticsClient;
  /** Electron's app-wide window events */
  appEvents: Pick<EventEmitter, 'on'>;
};

type Session = { host: AnalyticsHost; client: AnalyticsClient; savedInstallId: string };
type Install = { id: string; firstLaunch: boolean };
type EventProperties = Record<string, string | number | boolean>;

// Set by initAnalytics only when this build may send
let session: Session | null = null;
// Nothing is sent until the renderer reports the saved preference
let userOptedOut: boolean = true;
let appOpenTracked: boolean = false;
// When Frink last lost focus; null until then and after every focus or reopen
let unfocusedSince: number | null = null;
let allWindowsClosed: boolean = false;
let install: Install | null = null;
let installSaved: Promise<void> = Promise.resolve();

function electronHost(): AnalyticsHost {
  return {
    isPackaged: app.isPackaged,
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    key: import.meta.env.MAIN_VITE_POSTHOG_KEY,
    disableUsageAnalytics: process.env.FRINK_DISABLE_USAGE_ANALYTICS,
    createClient: (key) =>
      new PostHog(key, {
        host: import.meta.env.MAIN_VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
        // Flush events every 30 seconds or when 20 events are queued
        flushAt: 20,
        flushInterval: 30000,
      }),
    appEvents: app,
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

/** True when the launch environment switches usage analytics off ('0' and 'false' leave it on). */
function disabledForLaunch(value: string | undefined): boolean {
  return !!value && value !== '0' && value !== 'false';
}

/**
 * Initialize PostHog for main process. Unpackaged builds, builds without a key and
 * launches with FRINK_DISABLE_USAGE_ANALYTICS set get no session, so they send nothing.
 */
export function initAnalytics(host: AnalyticsHost = electronHost()) {
  if (session || !host.isPackaged || !host.key || disabledForLaunch(host.disableUsageAnalytics)) {
    return;
  }

  session = {
    host,
    client: host.createClient(host.key),
    savedInstallId: readSavedInstallId(host.userDataDir),
  };
  subscribeSessionCompletions(({ subChatId }) => trackReplyFinished(subChatId));
  host.appEvents
    .on('window-all-closed', onAllWindowsClosed)
    .on('browser-window-created', onWindowCreated)
    .on('browser-window-blur', onWindowBlurred)
    .on('browser-window-focus', onWindowFocused);
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
    trigger: 'launch',
    first_launch: firstLaunch,
  });

  if (firstLaunch) {
    // also fire a separate first_launch event for funnel analysis
    capture('first_launch');
  }
}

/** On macOS closing every window keeps Frink running, so a new window after that is a reopen */
function onAllWindowsClosed() {
  allWindowsClosed = true;
}

function onWindowCreated() {
  if (!allWindowsClosed) return;
  allWindowsClosed = false;
  // The reopened window's first focus is part of this open, not a return
  unfocusedSince = null;
  capture('desktop_opened', { trigger: 'window_reopened' });
}

function onWindowBlurred() {
  unfocusedSince = Date.now();
}

/** Counts focus that comes back after hours with no Frink window focused */
function onWindowFocused() {
  if (unfocusedSince !== null && Date.now() - unfocusedSince >= RETURN_AFTER_MS) {
    capture('desktop_opened', { trigger: 'returned_after_idle' });
  }
  unfocusedSince = null;
}

/** Track a message sent: the one a chat is created with from `chats.create`, the rest from the renderer */
export function trackMessageSent(event: MessageSentEvent & { startsChat: boolean }) {
  capture('message_sent', {
    workspace_id: event.workspaceId,
    message_length: event.messageLength,
    mode: event.mode,
    starts_chat: event.startsChat,
  });
}

/** Track a chat reply that finished; stopped replies and Flow turns publish no completion */
function trackReplyFinished(subChatId: string) {
  capture('reply_finished', {
    workspace_id: subChatId,
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

export type FlowTriggerKind = 'manual' | 'schedule' | 'webhook' | 'post_task' | 'none';

/** Track a Flow's first saved version, or a copy or import of a Flow */
export function trackFlowCreated(flow: {
  id: string;
  triggerType: FlowTriggerKind;
  createdBy: 'ui' | 'agent' | 'copy' | 'import';
}) {
  capture('flow_created', {
    flow_id: flow.id,
    trigger_type: flow.triggerType,
    created_by: flow.createdBy,
  });
}

/** Track a Flow run, or a whole batch, reaching a terminal state */
export function trackFlowRunCompleted(run: {
  flowId: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  stepCount: number;
  batchSize: number;
}) {
  capture('flow_run_completed', {
    flow_id: run.flowId,
    outcome: run.outcome,
    step_count: run.stepCount,
    batch_size: run.batchSize,
  });
}
