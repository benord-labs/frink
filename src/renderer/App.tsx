import { Provider as JotaiProvider, useAtomValue } from 'jotai';
import { ThemeProvider, useTheme } from 'next-themes';
import {
  type LazyExoticComponent,
  lazy,
  memo,
  type ReactElement,
  Suspense,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { Toaster } from 'sonner';
import { EasterEggOverlay } from './components/EasterEggOverlay';
import { PermissionPrompt, usePermissionPrompts } from './components/PermissionPrompt';
import { TooltipProvider } from './components/ui/tooltip';
import { WelcomeSplash } from './components/WelcomeSplash';
import { TRPCProvider } from './contexts/TRPCProvider';
import { splitViewChatIdsAtom } from './features/agents/atoms';
import { useLiveRunSync } from './features/agents/hooks/use-live-run-sync';
import { CopyAcrossPrompt } from './features/provider-config/CopyAcrossPrompt';
import { useFlowChatReplySync } from './hooks/use-flow-chat-reply-sync';
import { useFlowExecutionEvents } from './hooks/use-flow-execution-events';
import { useMcpBackgroundPrefetch } from './hooks/use-mcp-background-prefetch';
import { useMcpImportInvalidation } from './hooks/use-mcp-import-invalidation';
import { useSubChatModeSync } from './hooks/use-sub-chat-mode-sync';
import { initAnalytics, shutdown } from './lib/analytics';
import { pendingAccountAuthAtom } from './lib/atoms';
import { appStore } from './lib/jotai-store';
import { useSubagentTaskSync } from './lib/stores/use-subagent-task-sync';
import { useWakeHoldSync } from './lib/stores/use-wake-hold-sync';
import { ThemeEffects } from './lib/themes/theme-effects';

// Type for lazy-loaded page components
type LazyPage = LazyExoticComponent<() => ReactElement>;

// Lazy load route-level components for code splitting
const AgentsLayout: LazyPage = lazy(() =>
  import('./features/layout/agents-layout').then((m) => ({ default: m.AgentsLayout })),
);
// ConnectClaudeAccountPage used by Settings → Connect Claude / reauth flows.
const ConnectClaudeAccountPage: LazyPage = lazy(() =>
  import('./features/onboarding').then((m) => ({ default: m.ConnectClaudeAccountPage })),
);
// ConnectCodexAccountPage used by Settings → Connect Codex (dark behind LAUNCH_FLAGS.codexAccounts).
const ConnectCodexAccountPage: LazyPage = lazy(() =>
  import('./features/onboarding').then((m) => ({ default: m.ConnectCodexAccountPage })),
);

// Loading fallback for lazy components.
// Shares .loading-atmosphere with the HTML bootstrap loader so there's no style
// shift when the React bundle takes over from the static loading screen.
const PageLoader = () => (
  <div
    className="loading-atmosphere flex h-full w-full items-center justify-center"
    style={{ backgroundColor: 'var(--loading-bg)' }}
  >
    <svg
      className="h-[68px] w-[68px]"
      viewBox="0 0 500 500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      style={{
        color: 'var(--loading-logo)',
        animation: 'pulse 1.5s ease-in-out infinite',
      }}
    >
      <title>Frink loading logo</title>
      <path
        d="M350.3 166.97L244.64 229.85C237.67 234 233.44 241.34 233.46 249.24C233.59 291.18 233.7 333.12 233.84 375.04L149.69 426.42V219.37C149.69 204.69 157.5 191.03 170.37 183.19L350.3 73.59V166.97Z"
        fill="currentColor"
      />
      <path
        d="M350.3 199.41V285.79L260.18 340.79V263.8C260.18 257.46 263.57 251.57 269.15 248.22L350.3 199.41Z"
        fill="currentColor"
      />
    </svg>
  </div>
);

/**
 * Gate component - cheap, no splitView subscription.
 * Only mounts ActivePermissionPrompt when a request exists.
 */
const GlobalPermissionPrompt = memo(function GlobalPermissionPrompt() {
  const {
    currentRequest,
    currentPosition,
    queueTotal,
    approve,
    deny,
    next,
    previous,
    removeOrphanedRequests,
  } = usePermissionPrompts();
  if (!currentRequest) return null;

  return (
    <ActivePermissionPrompt
      currentRequest={currentRequest}
      currentPosition={currentPosition}
      queueTotal={queueTotal}
      approve={approve}
      deny={deny}
      next={next}
      previous={previous}
      removeOrphanedRequests={removeOrphanedRequests}
    />
  );
});

/**
 * Inner component - only mounted when a permission request is active.
 * Subscribes to splitViewChatIdsAtom to resolve pane number.
 */
const ActivePermissionPrompt = memo(function ActivePermissionPrompt({
  currentRequest,
  currentPosition,
  queueTotal,
  approve,
  deny,
  next,
  previous,
  removeOrphanedRequests,
}: {
  currentRequest: NonNullable<ReturnType<typeof usePermissionPrompts>['currentRequest']>;
  currentPosition: number;
  queueTotal: number;
  approve: ReturnType<typeof usePermissionPrompts>['approve'];
  deny: ReturnType<typeof usePermissionPrompts>['deny'];
  next: ReturnType<typeof usePermissionPrompts>['next'];
  previous: ReturnType<typeof usePermissionPrompts>['previous'];
  removeOrphanedRequests: ReturnType<typeof usePermissionPrompts>['removeOrphanedRequests'];
}) {
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const previousChatIdsRef = useRef<string[]>([]);

  // Auto-deny only when a pane was closed (chat removed from list), not when request arrived before list updated
  useEffect(() => {
    const activeChatIds = chatIds.filter((id): id is string => id !== null);
    removeOrphanedRequests(activeChatIds, previousChatIdsRef.current);
    previousChatIdsRef.current = activeChatIds;
  }, [chatIds, removeOrphanedRequests]);

  // Resolve chatId → 1-indexed pane number (only meaningful with >= 2 panes)
  const paneNumber = useMemo(() => {
    if (chatIds.length < 2 || !currentRequest.chatId) return undefined;
    const idx = chatIds.indexOf(currentRequest.chatId);
    if (idx < 0) return undefined;
    return idx + 1;
  }, [chatIds, currentRequest.chatId]);

  // Memoize to preserve referential identity for PermissionHeader memo
  const queueInfo = useMemo(
    () => (queueTotal > 1 ? { current: currentPosition, total: queueTotal } : undefined),
    [queueTotal, currentPosition],
  );

  return (
    <section
      className="fixed bottom-4 right-4 z-100 max-w-md"
      aria-live="polite"
      aria-label="Permission requests"
    >
      <PermissionPrompt
        key={currentRequest.requestId}
        request={currentRequest}
        onApprove={approve}
        onDeny={deny}
        paneNumber={paneNumber}
        queueInfo={queueInfo}
        onNext={queueTotal > 1 ? next : undefined}
        onPrevious={queueTotal >= 3 ? previous : undefined}
      />
    </section>
  );
});

/**
 * Custom Toaster that adapts to theme
 */
const ThemedToaster = memo(function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      position="bottom-right"
      theme={resolvedTheme as 'light' | 'dark' | 'system'}
      closeButton
    />
  );
});

/** Mounts global event listeners: flow execution, chat reply sync, and MCP sync. */
function GlobalEventListeners() {
  useLiveRunSync();
  useFlowExecutionEvents();
  useFlowChatReplySync();
  useSubChatModeSync();
  useWakeHoldSync();
  useSubagentTaskSync();
  useMcpBackgroundPrefetch();
  useMcpImportInvalidation();
  return null;
}

/**
 * Main content router - decides which page to show
 * Post-signin: chat interface (AgentsLayout) or OAuth when adding account from Settings
 */
const AppContent = memo(function AppContent() {
  const pendingAccountAuth = useAtomValue(pendingAccountAuthAtom);

  // Show the Connect page when a passthrough connect/reauth flow is pending.
  // The provider discriminator routes to Codex; absent/Claude is the default.
  if (pendingAccountAuth !== null) {
    return (
      <Suspense fallback={<PageLoader />}>
        {pendingAccountAuth.provider === 'codex' ? (
          <ConnectCodexAccountPage />
        ) : (
          <ConnectClaudeAccountPage />
        )}
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <AgentsLayout />
    </Suspense>
  );
});

export function App() {
  // Initialize analytics on mount
  useEffect(() => {
    initAnalytics();

    // Sync analytics opt-out status to main process
    const syncOptOutStatus = async () => {
      try {
        const optOut = localStorage.getItem('preferences:analytics-opt-out') === 'true';
        await window.desktopApi?.setAnalyticsOptOut(optOut);
      } catch (_error) {}
    };
    syncOptOutStatus();

    // Cleanup on unmount
    return () => {
      shutdown();
    };
  }, []);

  return (
    <JotaiProvider store={appStore}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <ThemeEffects>
          <TooltipProvider delayDuration={100}>
            <TRPCProvider>
              <GlobalEventListeners />
              <div
                data-agents-page
                className="h-screen w-screen bg-background text-foreground overflow-hidden"
              >
                <AppContent />
              </div>
              <ThemedToaster />
              <GlobalPermissionPrompt />
              <CopyAcrossPrompt />
              <EasterEggOverlay />
              <WelcomeSplash />
            </TRPCProvider>
          </TooltipProvider>
        </ThemeEffects>
      </ThemeProvider>
    </JotaiProvider>
  );
}
