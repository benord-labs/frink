import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SettingsList, SoftButton } from '@/components/settings/SettingsList';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { useIsNarrowScreen } from '@/hooks/use-is-narrow-screen';
import { getFileManagerName } from '@/lib/utils/platform';
import { showMessageJsonAtom } from '../../../features/agents/atoms';
import { trpc } from '@/lib/trpc';
import { Switch } from '../../ui/switch';
import { SettingsTabHeader } from './SettingsTabHeader';
import { SETTINGS_TAB_PAGE_CLASS } from './settings-tab-surface';

// React Scan state management (only available in dev mode)
const REACT_SCAN_SCRIPT_ID = 'react-scan-script';
const REACT_SCAN_STORAGE_KEY = 'react-scan-enabled';

const PLATFORM_NAMES = new Map([
  ['darwin', 'macOS'],
  ['win32', 'Windows'],
  ['linux', 'Linux'],
]);

function loadReactScan(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(REACT_SCAN_SCRIPT_ID)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.id = REACT_SCAN_SCRIPT_ID;
    script.src = 'https://unpkg.com/react-scan/dist/auto.global.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load React Scan'));
    document.head.appendChild(script);
  });
}

function unloadReactScan(): void {
  document.getElementById(REACT_SCAN_SCRIPT_ID)?.remove();
  document.querySelector('[data-react-scan]')?.remove();
}

/** One flat row in the Agent setup list language: name over a single muted line, control on the right. */
function DebugRow({
  name,
  description,
  mono = false,
  children,
}: {
  name: string;
  description: string;
  mono?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <li className="flex items-center gap-3.5 border-hairline border-b px-2 py-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink text-sm">{name}</span>
        <span
          className={`mt-0.5 block truncate text-muted-fg ${mono ? 'font-mono text-xs' : 'text-sm'}`}
          title={description}
        >
          {description}
        </span>
      </span>
      {children}
    </li>
  );
}

function DeveloperTools(): ReactElement {
  const [reactScanEnabled, setReactScanEnabled] = useState(false);
  const [reactScanLoading, setReactScanLoading] = useState(false);
  const [showMessageJson, setShowMessageJson] = useAtom(showMessageJsonAtom);

  useEffect(() => {
    if (localStorage.getItem(REACT_SCAN_STORAGE_KEY) === 'true') {
      loadReactScan()
        .then(() => setReactScanEnabled(true))
        .catch(() => {});
    }
  }, []);

  const handleReactScanToggle = async (enabled: boolean) => {
    setReactScanLoading(true);
    try {
      if (enabled) {
        await loadReactScan();
        localStorage.setItem(REACT_SCAN_STORAGE_KEY, 'true');
      } else {
        unloadReactScan();
        localStorage.removeItem(REACT_SCAN_STORAGE_KEY);
      }
      setReactScanEnabled(enabled);
      toast.success(enabled ? 'React Scan is on' : 'React Scan is off', {
        description: 'Reload the window to see the change everywhere.',
      });
    } catch {
      toast.error("React Scan couldn't load");
    } finally {
      setReactScanLoading(false);
    }
  };

  return (
    <SettingsSection title="Developer tools">
      <SettingsList>
        <DebugRow name="React Scan" description="Highlight components as they re-render">
          <Switch
            checked={reactScanEnabled}
            onCheckedChange={handleReactScanToggle}
            disabled={reactScanLoading}
            aria-label="React Scan"
          />
        </DebugRow>
        <DebugRow name="Message JSON" description="Show the raw data under each chat message">
          <Switch
            checked={showMessageJson}
            onCheckedChange={setShowMessageJson}
            aria-label="Message JSON"
          />
        </DebugRow>
        <DebugRow name="DevTools" description="Inspect this window">
          <SoftButton onClick={() => window.desktopApi?.toggleDevTools()}>Open</SoftButton>
        </DebugRow>
      </SettingsList>
    </SettingsSection>
  );
}

export function AgentsDebugTab(): ReactElement {
  const isNarrowScreen = useIsNarrowScreen();
  const { data: systemInfo } = trpc.debug.getSystemInfo.useQuery();
  const openFolderMutation = trpc.debug.openUserDataFolder.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const openLogFolderMutation = trpc.debug.openLogFolder.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const openLabel = `Show in ${getFileManagerName()}`;

  const summary = systemInfo
    ? `Frink ${systemInfo.version} on ${PLATFORM_NAMES.get(systemInfo.platform) ?? systemInfo.platform} (${systemInfo.arch})`
    : 'Frink';

  const handleCopyDetails = async () => {
    if (!systemInfo) return;
    await navigator.clipboard.writeText(
      JSON.stringify({ ...systemInfo, timestamp: new Date().toISOString() }, null, 2),
    );
    toast.success('Details copied');
  };

  return (
    <div className={SETTINGS_TAB_PAGE_CLASS}>
      <SettingsTabHeader
        title="Debug"
        description={`${summary}. Copy these details when you report a problem.`}
        narrow={isNarrowScreen}
        actions={
          <Button variant="primary" size="sm" onClick={handleCopyDetails} disabled={!systemInfo}>
            Copy details
          </Button>
        }
      />

      <SettingsSection title="Files">
        <SettingsList>
          <DebugRow name="Logs" description={systemInfo?.logFilePath ?? '—'} mono>
            <SoftButton onClick={() => openLogFolderMutation.mutate()}>{openLabel}</SoftButton>
          </DebugRow>
          <DebugRow name="App data" description={systemInfo?.userDataPath ?? '—'} mono>
            <SoftButton onClick={() => openFolderMutation.mutate()}>{openLabel}</SoftButton>
          </DebugRow>
        </SettingsList>
      </SettingsSection>

      {import.meta.env.DEV ? <DeveloperTools /> : null}
    </div>
  );
}
