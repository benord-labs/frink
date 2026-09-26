/* eslint-disable max-lines, max-lines-per-function */

import { Button, Input } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { useIsNarrowScreen } from '@/hooks/use-is-narrow-screen';
import { cn } from '@/lib/utils';
import {
  analyticsOptOutAtom,
  desktopNotificationsEnabledAtom,
  promptCacheTimerEnabledAtom,
  soundNotificationsEnabledAtom,
} from '../../../lib/atoms';
import { trpc } from '../../../lib/trpc';
import { Switch } from '../../ui/switch';
import { FlowConcurrencySettings } from './FlowConcurrencySettings';
import { SettingsTabHeader } from './SettingsTabHeader';
import { SETTINGS_TAB_PAGE_CLASS } from './settings-tab-surface';

export function AgentsPreferencesTab() {
  const [soundEnabled, setSoundEnabled] = useAtom(soundNotificationsEnabledAtom);
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useAtom(
    desktopNotificationsEnabledAtom,
  );
  const [promptCacheTimerEnabled, setPromptCacheTimerEnabled] = useAtom(
    promptCacheTimerEnabledAtom,
  );
  const [analyticsOptOut, setAnalyticsOptOut] = useAtom(analyticsOptOutAtom);
  const isNarrowScreen = useIsNarrowScreen();
  const [worktreePathInput, setWorktreePathInput] = useState('');

  const { data: worktreeBasePath, refetch: refetchWorktreeBasePath } =
    trpc.claudeSettings.getWorktreeBasePath.useQuery();
  const setWorktreeBasePathMutation = trpc.claudeSettings.setWorktreeBasePath.useMutation({
    onSuccess: (result) => {
      toast.success('Worktree base path updated');
      setWorktreePathInput(result.path);
      refetchWorktreeBasePath();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  const resetWorktreeBasePathMutation = trpc.claudeSettings.resetWorktreeBasePath.useMutation({
    onSuccess: (result) => {
      toast.success('Worktree base path reset to default');
      setWorktreePathInput(result.path);
      refetchWorktreeBasePath();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  useEffect(() => {
    if (worktreeBasePath?.path) {
      setWorktreePathInput(worktreeBasePath.path);
    }
  }, [worktreeBasePath?.path]);

  // Sync opt-out status to main process
  const handleAnalyticsToggle = async (optedOut: boolean) => {
    setAnalyticsOptOut(optedOut);
    // Notify main process
    try {
      await window.desktopApi?.setAnalyticsOptOut(optedOut);
    } catch (_error) {}
  };

  return (
    <div className={cn(SETTINGS_TAB_PAGE_CLASS, 'min-h-0')}>
      <SettingsTabHeader
        title="Preferences"
        description="Configure behavior and features"
        narrow={isNarrowScreen}
      />

      <SettingsSection title="Features">
        <SettingsCard>
          <div className="divide-y divide-border/60">
            {/* Desktop Notifications */}
            <div className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm font-medium text-foreground">Desktop Notifications</span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  Show a system notification when work finishes while Frink is in the background
                </span>
              </div>
              <Switch
                checked={desktopNotificationsEnabled}
                onCheckedChange={setDesktopNotificationsEnabled}
                className="shrink-0"
              />
            </div>

            {/* Sound Notifications */}
            <div className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm font-medium text-foreground">Sound Notifications</span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  Play a sound while you're away when work finishes, fails, pauses for input, or
                  needs your approval — each with its own distinct chime
                </span>
              </div>
              <Switch
                checked={soundEnabled}
                onCheckedChange={setSoundEnabled}
                className="shrink-0"
              />
            </div>

            {/* Prompt Cache Timer */}
            <div className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm font-medium text-foreground">Prompt Cache Timer</span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  Show how long Claude's prompt cache stays warm after a reply. Messages sent after
                  it expires re-send the full context uncached, which is slower and costs more
                </span>
              </div>
              <Switch
                checked={promptCacheTimerEnabled}
                onCheckedChange={setPromptCacheTimerEnabled}
                className="shrink-0"
              />
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <FlowConcurrencySettings />

      <SettingsSection title="Privacy">
        <SettingsCard>
          <div className="px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm font-medium text-foreground">Share Usage Analytics</span>
                <span className="text-xs text-muted-foreground leading-relaxed">
                  Help us improve by sharing anonymous usage data. We only track feature usage and
                  app performance—never your code, prompts, or messages. No AI training on your
                  data.
                </span>
              </div>
              <Switch
                checked={!analyticsOptOut}
                onCheckedChange={(enabled) => handleAnalyticsToggle(!enabled)}
                className="shrink-0"
              />
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Storage">
        <SettingsCard>
          <div className="px-4 py-3 space-y-3">
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Default Worktree Base Path
              </span>
              <span className="text-xs text-muted-foreground leading-relaxed">
                Default location for new worktrees unless a project override is configured in
                project settings. Existing worktrees are not moved automatically.
              </span>
            </div>
            <Input
              value={worktreePathInput}
              onChange={(event) => setWorktreePathInput(event.target.value)}
              placeholder={worktreeBasePath?.defaultPath ?? '~/.frink/worktrees'}
              className="font-mono"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Default: {worktreeBasePath?.defaultPath ?? '~/.frink/worktrees'}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => resetWorktreeBasePathMutation.mutate()}
                  disabled={resetWorktreeBasePathMutation.isPending || worktreeBasePath?.isDefault}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    setWorktreeBasePathMutation.mutate({ path: worktreePathInput.trim() })
                  }
                  disabled={
                    setWorktreeBasePathMutation.isPending || worktreePathInput.trim() === ''
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
