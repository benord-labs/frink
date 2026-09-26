/**
 * Predicate + wiring: does this webContents navigation mean local agents must be torn down?
 *
 * Wires to `webContents.on('did-start-navigation', …)` where the first argument is
 * `Event<WebContentsDidStartNavigationEventParams>` (Electron 40+): same-document
 * navigations and subframe navigations must not abort main-window agents.
 *
 * The predicate is pure and unit-tested; the lifecycle wiring lives beside it so
 * windows/main.ts stays assembly-only.
 */
import { app, type WebContents } from 'electron';
import log from 'electron-log';
import { captureContained } from '../lib/sentry';
import { abortActiveExecutionsForWebContents } from '../lib/socket/executor';
import { releaseExecutionOwnershipForWebContents } from '../lib/socket/streaming/execution-registry';
import { releaseLiveStreamOwnershipForWebContents } from '../lib/socket/streaming/live-stream';

type NavigationAbortDetails = {
  isSameDocument: boolean;
  isMainFrame: boolean;
  url?: string;
  /** Present on real events; tests may omit when not relevant. */
  frame?: import('electron').WebFrameMain | null;
};

/**
 * @param isPackaged `app.isPackaged` — false under `electron-vite dev`.
 *
 * Unpackaged, a main-frame document navigation is a Vite full reload, never a user action: the app
 * is a single-page renderer, so genuine in-app navigation is same-document and already excluded
 * above. Editing any file under `src/renderer/` therefore used to kill every live agent in the
 * window — including runs a parallel session started, whose author never touched the app. A
 * renderer crash is unaffected: it arrives on `render-process-gone`, not here.
 */
export function shouldAbortAgentsOnNavigation(
  details: NavigationAbortDetails,
  isPackaged: boolean,
): boolean {
  if (details.isSameDocument) return false;
  if (!details.isMainFrame) return false;
  return isPackaged;
}

const RENDERER_RELOAD_COOLDOWN_MS = 5 * 60_000;
const lastRendererReloadAt = new Map<number, number>();

/**
 * At most one automatic reload per webContents per cooldown prevents an unbounded crash/reload
 * loop. Reloadable reasons are the involuntary deaths — 'crashed', 'oom', and the OS-initiated
 * 'memory-eviction'. Teardown reasons ('clean-exit', 'killed') never reload — those are quits.
 */
const AUTO_RELOAD_REASONS = new Set(['crashed', 'oom', 'memory-eviction']);

function shouldAutoReloadRenderer(reason: string, webContentsId: number, now: number): boolean {
  if (!AUTO_RELOAD_REASONS.has(reason)) return false;
  const last = lastRendererReloadAt.get(webContentsId) ?? 0;
  if (now - last < RENDERER_RELOAD_COOLDOWN_MS) return false;
  lastRendererReloadAt.set(webContentsId, now);
  return true;
}

export function _resetRendererReloadCooldownForTests(): void {
  lastRendererReloadAt.clear();
}

function canAttemptRendererRecovery(wc: WebContents, reason: string, now: number): boolean {
  if (wc.isDestroyed()) return false;
  return shouldAutoReloadRenderer(reason, wc.id, now);
}

/**
 * Non-recoverable death (teardown reason, or an involuntary death still inside the reload
 * cooldown): tear down active runs. A cooldown-suppressed crash also leaves a genuinely dead
 * frame behind — no timer will resurrect it — so that case additionally reaches Sentry.
 */
function abortDeadRenderer(wc: WebContents, reason: string): void {
  abortActiveExecutionsForWebContents(wc.id, 'renderer-crashed');
  if (wc.isDestroyed() || !AUTO_RELOAD_REASONS.has(reason)) return;
  log.error('[Window] Renderer crash within reload cooldown — frame left dead');
  captureContained(new Error(`renderer dead frame (${reason}) within reload cooldown`), {
    surface: 'renderer-dead-frame',
  });
}

type RendererLifecycleOptions = {
  now?: () => number;
};

/** Tear down window-scoped agent runs when this renderer crashes or hard-navigates. */
export function attachAgentAbortOnRendererLifecycle(
  wc: WebContents,
  options: RendererLifecycleOptions = {},
): void {
  const now = options.now ?? Date.now;
  // The recovery reload is itself a main-frame navigation of the same URL; the handler below
  // consumes exactly that one so a packaged app does not abort the runs it is preserving. Any
  // renderer death or destroy before it fires voids the exemption.
  let recoveryReloadUrl: string | null = null;

  wc.on('destroyed', () => {
    recoveryReloadUrl = null;
    // On macOS closing the last window does not quit the app. Main-owned work keeps running and a
    // later window can observe it, but no delivery owner may remain attached to the dead frame.
    releaseExecutionOwnershipForWebContents(wc.id);
    releaseLiveStreamOwnershipForWebContents(wc.id);
  });

  wc.on('render-process-gone', (_event, details) => {
    log.error('[Window] Renderer process gone:', details);
    recoveryReloadUrl = null;
    if (!canAttemptRendererRecovery(wc, details.reason, now())) {
      abortDeadRenderer(wc, details.reason);
      return;
    }

    // Electron same-channel IPC is ordered and reliable, and reload() replaces the whole document
    // context — there is nothing to hand off. Release ownership up front and let the reloaded
    // renderer rehydrate its pending permissions/questions/wake-holds and stream state via tRPC
    // projection queries; a frame that fails to come back leaves runs alive and checkpointing to
    // SQLite rather than aborting healthy work on a timer.
    releaseExecutionOwnershipForWebContents(wc.id);
    releaseLiveStreamOwnershipForWebContents(wc.id);
    log.warn('[Window] Reloading crashed renderer while preserving main-owned runs');
    recoveryReloadUrl = wc.getURL();
    try {
      wc.reload();
    } catch (error) {
      recoveryReloadUrl = null;
      captureContained(error instanceof Error ? error : new Error(String(error)), {
        surface: 'renderer-recovery-failed',
        stage: 'reload-threw',
      });
      abortActiveExecutionsForWebContents(wc.id, 'renderer-crashed');
    }
  });

  wc.on('did-start-navigation', (details) => {
    if (recoveryReloadUrl !== null && details.isMainFrame && !details.isSameDocument) {
      const isRecoveryReload = details.url === recoveryReloadUrl;
      recoveryReloadUrl = null;
      if (isRecoveryReload) return;
    }
    if (shouldAbortAgentsOnNavigation(details, app.isPackaged)) {
      abortActiveExecutionsForWebContents(wc.id, 'renderer-reload');
      return;
    }
    // Dev full reload (same event, unpackaged): runs deliberately survive, but the reloaded
    // window loses its stream transports while keeping its webContents.id — release stream-chunk
    // ownership so those runs repaint via observer-lane snapshots instead of a frozen transcript.
    if (shouldAbortAgentsOnNavigation(details, true)) {
      releaseExecutionOwnershipForWebContents(wc.id);
      releaseLiveStreamOwnershipForWebContents(wc.id);
    }
  });
}
