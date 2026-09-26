/**
 * PostHog analytics for Frink Desktop - Renderer Process
 * Uses PostHog JS SDK for client-side tracking
 */

import posthog from 'posthog-js';

// PostHog configuration from environment
const POSTHOG_DESKTOP_KEY = import.meta.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

let initialized = false;
let appVersion: string | null = null;
let appPlatform: string | null = null;
let appArch: string | null = null;

// Check if we're in development mode
// Renderer can't access env vars directly, so we check a global flag
const isDev =
  typeof window !== 'undefined' &&
  window.location.hostname === 'localhost' &&
  !window.__FORCE_ANALYTICS__;

/**
 * Check if user has opted out of analytics
 * Reads directly from localStorage to avoid circular dependencies
 */
function isOptedOut(): boolean {
  try {
    const optOut = localStorage.getItem('preferences:analytics-opt-out');
    return optOut === 'true';
  } catch {
    return false;
  }
}

/**
 * Get common properties for all events
 */
function getCommonProperties() {
  return {
    // biome-ignore lint/style/useNamingConvention: PostHog event property name
    app_version: appVersion,
    platform: appPlatform,
    arch: appArch,
    source: 'desktop_renderer',
  };
}

/**
 * Initialize PostHog for renderer process
 */
export async function initAnalytics() {
  // Skip in development mode
  if (isDev) return;

  if (initialized) return;

  // Skip if no PostHog key configured
  if (!POSTHOG_DESKTOP_KEY) {
    return;
  }

  // Get app info from main process
  try {
    if (window.desktopApi?.getVersion) {
      appVersion = await window.desktopApi.getVersion();
    }
    if (window.desktopApi?.platform) {
      appPlatform = window.desktopApi.platform;
    }
    if (window.desktopApi?.arch) {
      appArch = window.desktopApi.arch;
    }
  } catch (_error) {}

  posthog.init(POSTHOG_DESKTOP_KEY, {
    // biome-ignore lint/style/useNamingConvention: PostHog SDK option
    api_host: POSTHOG_HOST,
    // Disable automatic tracking - we track manually
    autocapture: false,
    // biome-ignore lint/style/useNamingConvention: PostHog SDK option
    capture_pageview: false,
    // biome-ignore lint/style/useNamingConvention: PostHog SDK option
    capture_pageleave: false,
    // biome-ignore lint/style/useNamingConvention: PostHog SDK option
    disable_session_recording: true,
    // Privacy settings
    // biome-ignore lint/style/useNamingConvention: PostHog SDK option
    person_profiles: 'identified_only',
    persistence: 'localStorage',
  });

  initialized = true;
}

/**
 * Capture an analytics event
 */
function capture(eventName: string, properties?: Record<string, unknown>) {
  // Skip in development mode
  if (isDev) return;

  // Skip if user opted out
  if (isOptedOut()) return;

  if (!initialized) return;

  posthog.capture(eventName, {
    ...getCommonProperties(),
    ...properties,
  });
}

/**
 * Shutdown PostHog
 */
export function shutdown() {
  if (initialized) {
    posthog.reset();
    initialized = false;
  }
}

// ============================================================================
// Specific event helpers (for renderer-specific events)
// ============================================================================

/**
 * Track message sent from UI
 */
export function trackMessageSent(data: {
  workspaceId: string;
  messageLength: number;
  mode: 'plan' | 'agent' | 'debug';
}) {
  capture('message_sent', {
    // biome-ignore lint/style/useNamingConvention: PostHog event property name
    workspace_id: data.workspaceId,
    // biome-ignore lint/style/useNamingConvention: PostHog event property name
    message_length: data.messageLength,
    mode: data.mode,
  });
}
