/* eslint-disable max-lines, max-lines-per-function */
import { existsSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import log from 'electron-log';
import { AUTH_SERVER_PORT, IS_DEV, PROTOCOL } from './constants';
import { configureMainLog, getMainLogPath } from './lib/diagnostics/main-log';

configureMainLog();

// Regex pattern for extracting PID from singleton lock target
const PID_REGEX = /-(\d+)$/;

import { initAnalytics, shutdown as shutdownAnalytics } from './lib/analytics';
import { buildAppSubmenu } from './windows/app-menu';
import { checkForUpdates, initAutoUpdater, setupFocusUpdateCheck } from './lib/auto-updater';
import { getBundledClaudeVersion } from './lib/claude';
import { parseLaunchDirectory } from './lib/cli';
import { closeDatabase, getDatabase, getDatabasePath, initDatabase } from './lib/db';
import {
  markDiagnosticsCleanShutdown,
  markDiagnosticsShutdownStarted,
  registerElectronProcessGoneDiagnostics,
  startHeapWatch,
  stopHeapWatch,
} from './lib/diagnostics';
import { registerAttachmentSchemeAsPrivileged } from './lib/flows/attachments-protocol';
import { runStartupRecoveryAndLoops } from './lib/flows/startup';
import { cleanupGitWatchers } from './lib/git/watcher';
import { cancelAllPendingOAuth, handleMcpOAuthCallback } from './lib/mcp-auth';
import { initializeMobileAccess, stopMobileAccess } from './lib/mobile';
import { shellOpenExternalGuarded } from './lib/open-external-guarded';
import { setDocsLoader } from './lib/permissions/v2/check';
import { resolveScopes } from './lib/permissions/v2/scope-resolver';
import { captureMainException, initSentry } from './lib/sentry/init';
import { assertRigHomeIsolated } from './lib/platform/frink-home';
import { startLoginShellEnvResolve } from './lib/platform/login-shell-env';
import { assertRigRendererBundled } from './lib/platform/rig-renderer';
import './lib/socket';
import { initTaskExecutor } from './lib/task-executor';
import { getTaskPoller } from './lib/task-poller';
import {
  createMainWindow,
  DEFAULT_ZOOM_FACTOR,
  doZoomIn,
  doZoomOut,
  getWindow,
  writeWindowSettings,
} from './windows/main';

// Set dev mode userData path BEFORE requestSingleInstanceLock()
// This ensures dev and prod have separate instance locks.
// When AUTH_SERVER_PORT differs from default (21322), append it as a suffix so
// worktree dev instances get their own lock + DB (e.g. "Frink Dev-21323").
if (IS_DEV) {
  const { join } = require('node:path');
  const suffix = AUTH_SERVER_PORT !== 21322 ? `-${AUTH_SERVER_PORT}` : '';
  const devUserData = join(app.getPath('userData'), '..', `Frink Dev${suffix}`);
  app.setPath('userData', devUserData);
  // Expose CDP in dev (loopback-only, never in production) so automation can attach to the running
  // app; FRINK_CDP_PORT moves an isolated side-by-side instance off the owner's 9222.
  app.commandLine.appendSwitch('remote-debugging-port', process.env.FRINK_CDP_PORT ?? '9222');
  // Isolated instances (FRINK_CDP_PORT) run unattended and macOS safeStorage would stall them on a
  // Keychain modal (--password-store is Linux-only, plain-text mode a no-op): mock the keychain.
  if (process.env.FRINK_CDP_PORT) app.commandLine.appendSwitch('use-mock-keychain');
}

// Initialize Sentry before app is ready (production only).
// Uses defaultIntegrations:false + an explicit list to avoid pulling in the
// OpenTelemetry stack that previously broke electron-builder + bun packaging.
initSentry();
// An isolated instance must own its home before any path resolves under it (sc-2903).
assertRigHomeIsolated();
// The rig bundle must render its own out-qa renderer, never an inherited dev server.
assertRigRendererBundled();

// URL configuration (exported for use in other modules)
export function getAppUrl(): string {
  return process.env.ELECTRON_RENDERER_URL || 'http://localhost:3000';
}

// Handle deep link
function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);

    // Handle MCP OAuth callback: frink://mcp-oauth?code=xxx&state=yyy
    if (parsed.pathname === '/mcp-oauth' || parsed.host === 'mcp-oauth') {
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      if (code && state) {
        handleMcpOAuthCallback(code, state);
        return;
      }
    }
  } catch (_e) {}
}

/**
 * Register the app as the handler for our custom protocol.
 * On macOS, this may not take effect immediately on first install -
 * Launch Services caches protocol handlers and may need time to update.
 */
function registerProtocol(): boolean {
  // Non-primary dev instances (worktrees on a custom port) must not steal the handler
  // from the primary instance. Only the default dev port (21322) registers.
  if (IS_DEV && import.meta.env.MAIN_VITE_AUTH_SERVER_PORT) {
    return false;
  }

  let success: boolean = false;

  if (process.defaultApp) {
    // Dev mode: need to pass execPath and script path
    if (process.argv.length >= 2) {
      success = app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1] || '']);
    } else {
    }
  } else {
    // Production mode
    success = app.setAsDefaultProtocolClient(PROTOCOL);
  }

  return success;
}

// Store initial registration result (set in app.whenReady())
let initialRegistration: boolean = false;

// Verify registration (this checks if OS recognizes us as the handler).
// Production only — dev/worktree instances use frink-dev:// and must never be nagged.
function verifyProtocolRegistration(): void {
  if (IS_DEV) return;

  if (app.isDefaultProtocolClient(PROTOCOL) || !initialRegistration) return;

  // We registered the handler but the OS still routes frink:// elsewhere. Launch Services can
  // lag on first install, which silently breaks MCP and plugin OAuth (the browser can't hand the
  // callback back to the app). Re-registering or relaunching the same binary does not clear
  // that cache, so we surface the remedy once rather than nag or pretend a relaunch fixes it.
  const markerPath = join(app.getPath('userData'), '.protocol_warning_shown');
  if (existsSync(markerPath)) return;
  try {
    writeFileSync(markerPath, new Date().toISOString());
  } catch (_e) {
    // Can't persist the "shown once" marker → skip the notice rather than nag on every launch.
    return;
  }

  void dialog.showMessageBox({
    type: 'warning',
    message: 'Connecting a service may not return to Frink',
    detail:
      `Frink couldn't register the ${PROTOCOL}:// link handler macOS uses to finish connecting a plugin or MCP server. ` +
      'If a connection gets stuck in your browser, move Frink to your Applications folder and reopen it.',
    buttons: ['OK'],
  });
}

// Note: app.on("open-url") will be registered in app.whenReady()

// Clean up stale lock files from crashed instances
// Returns true if locks were cleaned, false otherwise
function cleanupStaleLocks(): boolean {
  const userDataPath = app.getPath('userData');
  const lockPath = join(userDataPath, 'SingletonLock');

  if (!existsSync(lockPath)) return false;

  try {
    // SingletonLock is a symlink like "hostname-pid"
    const lockTarget = readlinkSync(lockPath);
    const match = lockTarget.match(PID_REGEX);
    if (match) {
      const pid = parseInt(match[1], 10);
      try {
        // Check if process is running (signal 0 doesn't kill, just checks)
        process.kill(pid, 0);
        return false;
      } catch {
        const filesToRemove = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
        for (const file of filesToRemove) {
          const filePath = join(userDataPath, file);
          if (existsSync(filePath)) {
            try {
              unlinkSync(filePath);
            } catch (_e) {}
          }
        }
        return true;
      }
    }
  } catch (_e) {}
  return false;
}

// Prevent multiple instances
let gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Maybe stale lock - try cleanup and retry once
  const cleaned = cleanupStaleLocks();
  if (cleaned) {
    gotTheLock = app.requestSingleInstanceLock();
  }
  if (!gotTheLock) {
    app.quit();
  }
}

if (gotTheLock) {
  // Custom scheme privilege registration MUST happen before app.whenReady().
  // Without this, the renderer's CSP `'self'` rule blocks
  // `<img src="frink-attachment://...">` because the scheme is treated as
  // non-standard / opaque-origin by Chromium.
  try {
    registerAttachmentSchemeAsPrivileged();
  } catch (err) {
    log.warn('[Main] flows attachment scheme privilege register failed:', err);
  }

  // Handle second instance launch (also handles deep links on Windows/Linux)
  app.on('second-instance', (_event, commandLine) => {
    // Check for deep link in command line args
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (url) {
      handleDeepLink(url);
    }

    const window = getWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  // App ready
  app.whenReady().then(async () => {
    startHeapWatch();
    // GUI launches get a minimal PATH; resolve the user's shell PATH in the background.
    startLoginShellEnvResolve();

    // Set dev mode app name (userData path was already set before requestSingleInstanceLock)
    if (IS_DEV) {
      app.name = 'Agents Dev';
    }

    // Register protocol handler (must be after app is ready)
    initialRegistration = registerProtocol();

    // Handle deep link on macOS (app already running)
    app.on('open-url', (event, url) => {
      event.preventDefault();
      handleDeepLink(url);
    });

    // Set app user model ID for Windows (different in dev to avoid taskbar conflicts)
    if (process.platform === 'win32') {
      app.setAppUserModelId(IS_DEV ? 'dev.frink.app.dev' : 'dev.frink.app');
    }

    // Verify protocol registration after app is ready
    // This helps diagnose first-install issues where the protocol isn't recognized yet
    verifyProtocolRegistration();

    // Get Claude Code version for About panel (shared cached reader; null when unreadable).
    const claudeCodeVersion = getBundledClaudeVersion() ?? 'unknown';

    // Set About panel options with Claude Code version
    app.setAboutPanelOptions({
      applicationName: 'Frink',
      applicationVersion: app.getVersion(),
      version: `Claude Code ${claudeCodeVersion}`,
      copyright: '',
    });

    // Track update availability for menu
    let updateAvailable: boolean = false;
    let availableVersion: string | null = null;
    // Track devtools unlock state (hidden feature - 5 clicks on Beta tab)
    let devToolsUnlocked: boolean = false;

    // Function to build and set application menu
    const buildMenu = () => {
      // Show devtools menu item only in dev mode or when unlocked
      const showDevTools = !app.isPackaged || devToolsUnlocked;
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: app.name,
          submenu: buildAppSubmenu(getWindow, {
            available: updateAvailable,
            version: availableVersion,
          }),
        },
        {
          label: 'File',
          submenu: [
            {
              label: 'New Chat',
              accelerator: 'CmdOrCtrl+N',
              click: () => {
                const win = getWindow();
                if (win) {
                  win.webContents.send('shortcut:new-agent');
                } else {
                }
              },
            },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'View',
          submenu: [
            // Cmd+R is disabled to prevent accidental page refresh
            // Use Cmd+Shift+R (Force Reload) for intentional reloads
            { role: 'forceReload' },
            // Only show DevTools in dev mode or when unlocked via hidden feature
            ...(showDevTools ? [{ role: 'toggleDevTools' as const }] : []),
            { type: 'separator' },
            {
              label: 'Actual Size',
              accelerator: 'CommandOrControl+0',
              click: () => {
                const win = BrowserWindow.getFocusedWindow();
                if (win) {
                  win.webContents.setZoomFactor(DEFAULT_ZOOM_FACTOR);
                  writeWindowSettings({ zoomFactor: DEFAULT_ZOOM_FACTOR });
                }
              },
            },
            // No accelerators here: Cmd+= / Cmd+- are handled in the renderer (page-zoom-in/out)
            // so zoom applies once. Duplicate CommandOrControl+Equal/- menu accelerators caused
            // double application with the same IPC path (menu + renderer).
            {
              label: 'Zoom In',
              click: () => doZoomIn(),
            },
            {
              label: 'Zoom Out',
              click: () => doZoomOut(),
            },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            // macOS users expect Enter Full Screen here; togglefullscreen only lived under View
            ...(process.platform === 'darwin'
              ? ([{ type: 'separator' as const }, { role: 'togglefullscreen' as const }] as const)
              : []),
            { type: 'separator' },
            { role: 'front' },
          ],
        },
        {
          role: 'help',
          submenu: [
            {
              label: 'Learn More',
              click: async () => {
                await shell.openExternal('https://www.frink.dev/docs');
              },
            },
            {
              label: 'Send Feedback',
              click: () => {
                const subject = encodeURIComponent(`Frink feedback (v${app.getVersion()})`);
                void shellOpenExternalGuarded(`mailto:feedback@frink.dev?subject=${subject}`);
              },
            },
          ],
        },
      ];
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    };

    // Set update state and rebuild menu
    const setUpdateAvailable = (available: boolean, version?: string) => {
      updateAvailable = available;
      availableVersion = version || null;
      buildMenu();
    };

    // Unlock devtools and rebuild menu (called from renderer via IPC)
    const unlockDevTools = () => {
      if (!devToolsUnlocked) {
        devToolsUnlocked = true;
        buildMenu();
      }
    };

    // Expose setUpdateAvailable globally for auto-updater
    globalThis.__setUpdateAvailable = setUpdateAvailable;
    // Expose unlockDevTools globally for IPC handler
    globalThis.__unlockDevTools = unlockDevTools;

    // Build initial menu
    buildMenu();

    initAnalytics();

    // Initialize database
    try {
      initDatabase();
      log.info('[Main] Database initialized');
      // Wire the v2 permissions dispatcher to the local store + managed-policy reader
      // here, before any window exists, so no turn can run against the empty-docs stub.
      setDocsLoader((req) => resolveScopes(getDatabase(), req));
    } catch (dbError) {
      log.error('[Main] Database init failed:', dbError);
      const message = dbError instanceof Error ? dbError.message : String(dbError);
      const databasePath = getDatabasePath();
      const logPath = getMainLogPath();
      dialog.showErrorBox(
        'Database initialization failed',
        `Frink could not initialize its local database and cannot start.\n\nError: ${message}\n\nDatabase file: ${databasePath}\nLog file: ${logPath}\n\nPlease restart the app. If the problem persists, you can delete the database file above and relaunch Frink.`,
      );
      app.quit();
      return;
    }

    await runStartupRecoveryAndLoops();

    // Mobile access is opt-in; a port conflict must not prevent local work.
    await initializeMobileAccess().catch((error: unknown) => {
      log.warn('[Mobile] Could not restore mobile access:', error);
    });

    // Create main window
    log.info('[Main] Creating main window...');
    createMainWindow();
    log.info('[Main] Main window created');

    // Initialize auto-updater (production only)
    if (app.isPackaged) {
      await initAutoUpdater(getWindow);
      // Setup update check on window focus (instead of periodic interval)
      setupFocusUpdateCheck(getWindow);
      // Check for updates 5 seconds after startup (force to bypass interval check)
      setTimeout(() => {
        checkForUpdates(true);
      }, 5000);
    }

    // Auto-import native MCPs (Claude/Cursor) into Frink's own store.
    // Idempotent — every boot. The warm-up below MUST chain after this resolves: warm-up
    // populates `claudeToolsCache`, and the dedup filter in
    // `getAllMcpConfigHandler` reads `~/.frink/mcp/config.json` to know
    // which native entries to hide. Running the warm-up before the importer
    // finishes writing `importedFrom` would cache the un-deduped state.
    const importerPromise = (async () => {
      try {
        const { runMcpImporter } = await import('./lib/mcp/importer');
        const result = await runMcpImporter();
        if (result.imported > 0 || result.conflicts > 0) {
          // The renderer's `useMcpImportInvalidation` hook may not have
          // mounted yet on a fast importer / slow renderer boot. That's
          // intentionally tolerated: the renderer's first
          // `getAggregatedMcpInfo` / `listGlobalServers` /
          // `getAllMcpConfig` query reads the post-import on-disk state, so
          // correctness is preserved even if this IPC is missed. The
          // broadcast exists to refresh ALREADY-mounted renderers (other
          // open windows, or a renderer that finished mounting before the
          // importer resolved).
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('mcp:imported', result);
          }
        }
        return result;
      } catch (err) {
        log.warn('[mcp-import] failed:', err);
        return { imported: 0, conflicts: 0 };
      }
    })();

    // Warm up MCP cache 3 seconds AFTER importer resolves (background,
    // non-blocking). This populates the cache so all future sessions can
    // use filtered MCP servers.
    void importerPromise.then(() => {
      setTimeout(async () => {
        try {
          const { getAllMcpConfigHandler } = await import('./lib/trpc/routers/claude-mcp-config');
          await getAllMcpConfigHandler();
        } catch (_error) {}
      }, 3000);
    });

    // Provision Frink-managed skills (`~/.frink/skills/<name>/`) and project REAL
    // COPIES into the per-tool skill dirs (`~/.agents/skills`, `~/.claude/skills`,
    // `~/.cursor/skills`) so IDE agents discover them. Awaited (~15-20ms cold) so the
    // agent executor that starts on the 2s setTimeout below cannot race the first
    // projection. Boot-only; failures are logged but never abort startup. 5s hard
    // timeout guards against a stalled copy / fs resolution hanging boot.
    try {
      const { provisionFrinkSkills } = await import('./lib/skills');
      await Promise.race([
        provisionFrinkSkills(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('skill-provisioner timed out after 5s')), 5000),
        ),
      ]);
    } catch (err) {
      log.warn('[skill-provisioner] boot provisioning failed:', err);
    }

    // Start task poller and executor (background, non-blocking)
    setTimeout(async () => {
      try {
        // Initialize task executor (listens for claimed tasks)
        initTaskExecutor();

        // Start the poller
        const poller = getTaskPoller();
        await poller.start();
      } catch {}
    }, 2000);

    // Handle directory argument from CLI (e.g., `frink /path/to/project`)
    parseLaunchDirectory();

    // Handle deep link from app launch (Windows/Linux)
    const deepLinkUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
    }

    // macOS: Re-create window when dock icon is clicked
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  // Quit when all windows are closed (except on macOS)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Graceful shutdown: use preventDefault() to halt V8 teardown, run async
  // cleanup, then app.exit(). Without this, native module ThreadSafeFunction
  // callbacks (node-pty onData/onExit) fire after FreeEnvironment → SIGABRT.
  let isShuttingDown = false;
  app.on('before-quit', async (event) => {
    if (isShuttingDown) {
      event.preventDefault(); // Block re-entrant quit while cleanup is in progress
      return;
    }
    isShuttingDown = true;
    event.preventDefault();

    // Switch to sync logging so shutdown messages reach disk before exit
    log.transports.file.sync = true;
    log.info('[Shutdown] Graceful shutdown starting');

    // Hard deadline: force-exit if cleanup hangs
    const forceExitTimer = setTimeout(() => {
      log.warn('[Shutdown] Cleanup timed out after 5s, force-exiting');
      app.exit(1);
    }, 5000);
    forceExitTimer.unref();

    // Best-effort and time-bounded: cleanup must still start promptly. If it lands before an
    // interrupted shutdown, the next launch reports that state instead of guessing OOM.
    await markDiagnosticsShutdownStarted();

    try {
      // ── Phase 1: Stop event sources (sync — prevents new work) ──
      stopHeapWatch();
      await stopMobileAccess();
      cancelAllPendingOAuth();
      getTaskPoller().stop();
      // Held and idle CLI sessions stand down before Phase 2 kills child processes.
      const { releaseNonFlowClaudeSessions } = await import('./lib/socket/claude-wake-hold');
      releaseNonFlowClaudeSessions('app-quit');
      // Settle pending permission prompts as timed out before Phase 2 kills their child processes.
      const { drainPendingPermissions } =
        await import('./lib/socket/streaming/pending-permission/validate-tool-permission');
      drainPendingPermissions();
      // Flow subsystems started in app.whenReady — stop them here so the
      // setInterval timers don't fire into a closed DB during the 5s window.
      try {
        const { stopFlowEventBridge } = await import('./lib/flows/event-bridge');
        const { stopScheduleTriggerLoop } = await import('./lib/flows/schedule-trigger');
        const { stopTaskCompletionWatcher } = await import('./lib/flows/task-completion-watcher');
        const { stopPostTaskTriggerLoop } = await import('./lib/flows/post-task-trigger');
        stopFlowEventBridge();
        stopScheduleTriggerLoop();
        stopTaskCompletionWatcher();
        stopPostTaskTriggerLoop();
      } catch (err) {
        log.warn('[Shutdown] flow subsystem stop failed:', err);
      }
      const { stopIngestServer } = await import('./lib/debug-ingest/ingest-server');
      await stopIngestServer();

      // ── Phase 2: Kill native-module processes (async — drain TSF handles) ──
      const { terminalManager } = await import('./lib/terminal');
      await terminalManager.cleanup();

      // Tear down any warm `codex app-server` processes (persistent across turns).
      (await import('./lib/agent-runner/codex/app-server-registry')).disposeAllCodexAppServers();

      // ── Phase 3: Close DB and flush analytics ──
      await cleanupGitWatchers();
      // Drain any background rollback-stash promises kicked off by the socket
      // executor's fire-and-forget post-stream path. Without this, an in-flight
      // `git add -A` killed mid-walk can orphan `.git/index.lock`.
      const { drainInFlightRollbackStashes } = await import('./lib/git/stash');
      await drainInFlightRollbackStashes(2000);
      await Promise.race([
        shutdownAnalytics(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
      ]);
      closeDatabase();

      log.info('[Shutdown] Cleanup complete');
    } catch (err) {
      log.error('[Shutdown] Error during cleanup:', err);
    } finally {
      // Await the terminal marker before app.exit: an atomic write without ordering can still be
      // overwritten by an older sample that completes later. Keep the hard deadline armed while
      // this write is pending so diagnostics can never hang app shutdown.
      await markDiagnosticsCleanShutdown();
      clearTimeout(forceExitTimer);
      app.exit(0);
    }
  });

  process.on('uncaughtException', (error) => {
    log.error('[uncaughtException]', error);
    captureMainException(error, { source: 'uncaughtException' });
  });

  process.on('unhandledRejection', (reason) => {
    log.error('[unhandledRejection]', reason);
    captureMainException(reason, { source: 'unhandledRejection' });
  });

  process.on('warning', (warning) => {
    log.warn('[process-warning]', warning.name, warning.message);
  });

  registerElectronProcessGoneDiagnostics();
}
