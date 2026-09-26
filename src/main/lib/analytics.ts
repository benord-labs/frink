/**
 * PostHog analytics for Frink Desktop - Main Process
 * Uses PostHog Node.js SDK for server-side tracking
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { PostHog } from 'posthog-node';

const POSTHOG_DESKTOP_KEY = import.meta.env.MAIN_VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.MAIN_VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

let posthog: PostHog | null = null;
let userOptedOut: boolean = false; // Synced from renderer

// track first launch using a marker file
const FIRST_LAUNCH_MARKER = '.first_launch_tracked';

function getFirstLaunchMarkerPath(): string {
  try {
    return path.join(app.getPath('userData'), FIRST_LAUNCH_MARKER);
  } catch {
    // app not ready yet
    return '';
  }
}

function isFirstLaunch(): boolean {
  const markerPath = getFirstLaunchMarkerPath();
  if (!markerPath) return false;

  try {
    return !fs.existsSync(markerPath);
  } catch {
    return false;
  }
}

function markFirstLaunchTracked(): void {
  const markerPath = getFirstLaunchMarkerPath();
  if (!markerPath) return;

  try {
    fs.writeFileSync(markerPath, new Date().toISOString());
  } catch {
    // ignore errors writing marker
  }
}

// Check if we're in development mode
// Set FORCE_ANALYTICS=true to test analytics in development
// Use a function to check lazily after app is ready
function isDev(): boolean {
  try {
    return !app.isPackaged && process.env.FORCE_ANALYTICS !== 'true';
  } catch {
    // App not ready yet, assume dev mode
    return process.env.FORCE_ANALYTICS !== 'true';
  }
}

/**
 * Get common properties for all events
 */
function getCommonProperties() {
  return {
    source: 'desktop', // Unified source for desktop vs web analytics
    app_version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron_version: process.versions.electron,
    node_version: process.versions.node,
  };
}

/**
 * Set opt-out status (called from renderer when user preference changes)
 */
export function setOptOut(optedOut: boolean) {
  userOptedOut = optedOut;
}

/**
 * Initialize PostHog for main process
 */
export function initAnalytics() {
  // Skip in development mode
  if (isDev()) return;

  if (posthog) return;

  // Skip if no PostHog key configured
  if (!POSTHOG_DESKTOP_KEY) {
    return;
  }

  posthog = new PostHog(POSTHOG_DESKTOP_KEY, {
    host: POSTHOG_HOST,
    // Flush events every 30 seconds or when 20 events are queued
    flushAt: 20,
    flushInterval: 30000,
  });
}

/**
 * Capture an analytics event
 */
function capture(eventName: string, properties?: Record<string, unknown>) {
  // Skip in development mode
  if (isDev()) return;

  // Skip if user opted out
  if (userOptedOut) return;

  if (!posthog) return;

  posthog.capture({
    distinctId: 'anonymous',
    event: eventName,
    properties: {
      ...getCommonProperties(),
      ...properties,
    },
  });
}

/**
 * Shutdown PostHog and flush pending events
 */
export async function shutdown() {
  if (posthog) {
    await posthog.shutdown();
    posthog = null;
  }
}

// ============================================================================
// Specific event helpers
// ============================================================================

/**
 * Track app opened event
 */
export function trackAppOpened() {
  const firstLaunch = isFirstLaunch();

  capture('desktop_opened', {
    first_launch: firstLaunch,
  });

  if (firstLaunch) {
    // mark as tracked so subsequent opens don't count as first launch
    markFirstLaunchTracked();

    // also fire a separate first_launch event for funnel analysis
    capture('first_launch', {
      app_version: app.getVersion(),
      platform: process.platform,
    });
  }
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
  repository?: string;
}) {
  capture('workspace_created', {
    workspace_id: workspace.id,
    project_id: workspace.projectId,
    use_worktree: workspace.useWorktree,
    repository: workspace.repository,
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
export function trackPRCreated(data: {
  workspaceId: string;
  prNumber: number;
  repository?: string;
  mode?: 'worktree' | 'local';
}) {
  capture('pr_created', {
    workspace_id: data.workspaceId,
    pr_number: data.prNumber,
    repository: data.repository,
    mode: data.mode,
  });
}
