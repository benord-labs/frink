import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { useSettingsNavigation } from '@/hooks/useSettingsNavigation';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { SettingsTabHeader } from '../SettingsTabHeader';
import { SETTINGS_PANEL_CLASS, SETTINGS_TAB_PAGE_CLASS } from '../settings-tab-surface';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ProviderUsage } from './ProviderUsage';
import { UsageInsights } from './UsageInsights';
import { UsageStats } from './UsageStats';

const USAGE_QUERY_OPTIONS = {
  staleTime: 30_000,
  refetchInterval: 60_000,
  refetchOnWindowFocus: true,
} as const;

/** A ticking clock so reset countdowns and the "updated Xm ago" label stay live without a refetch. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function NotConnected({ provider }: { provider: string }): ReactElement {
  const { openSettingsTab } = useSettingsNavigation();
  return (
    <p className="text-sm text-muted-foreground">
      Connect your {provider} subscription to see how much of your plan is left. API-key accounts
      don't have plan limits.{' '}
      <button
        type="button"
        onClick={() => openSettingsTab('models')}
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        Open AI providers
      </button>
    </p>
  );
}

/** History re-scans in the background at most once a minute; it needs no polling of its own. */
const HISTORY_QUERY_OPTIONS = { staleTime: 60_000, refetchOnWindowFocus: true } as const;

function HistorySection(): ReactElement {
  const history = trpc.usageHistory.get.useQuery(undefined, HISTORY_QUERY_OPTIONS);
  const activity = trpc.usageHistory.activity.useQuery(undefined, HISTORY_QUERY_OPTIONS);
  if (!history.data || history.data.since === null) {
    const message = history.isLoading
      ? 'Reading your chat history. The first time takes a moment.'
      : history.isError
        ? "Couldn't read your chat history. It'll try again shortly."
        : 'Your activity will show here after your first chat.';
    return <p className={cn(SETTINGS_PANEL_CLASS, 'text-sm text-muted-foreground')}>{message}</p>;
  }
  return (
    <>
      <UsageStats history={history.data} />
      <ActivityHeatmap history={history.data} />
      <UsageInsights history={history.data} activity={activity.data} />
    </>
  );
}

/** Settings → Usage: how you've used Frink, and how much of each subscription plan is left. */
export function AgentsUsageTab(): ReactElement {
  const claude = trpc.usage.getRateLimits.useQuery(undefined, USAGE_QUERY_OPTIONS);
  const codex = trpc.usage.getCodexUsage.useQuery(undefined, USAGE_QUERY_OPTIONS);
  const now = useNow(30_000);

  return (
    <div className={SETTINGS_TAB_PAGE_CLASS}>
      <SettingsTabHeader
        title="Usage"
        titleAs="h1"
        description="How you've used Frink on this computer, and what's left of your plans"
      />
      <HistorySection />
      <SettingsSection title="Plan limits">
        <ProviderUsage
          provider="Claude"
          query={claude}
          manage={{ label: 'Manage usage on claude.ai', url: 'https://claude.ai/settings/usage' }}
          unavailable={<NotConnected provider="Claude" />}
          now={now}
        />
        <ProviderUsage
          provider="OpenAI"
          query={codex}
          manage={{
            label: 'Manage usage on chatgpt.com',
            url: 'https://chatgpt.com/codex/settings/usage',
          }}
          unavailable={<NotConnected provider="OpenAI" />}
          now={now}
        />
      </SettingsSection>
    </div>
  );
}
