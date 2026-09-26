import type { ReactElement } from 'react';
import { SettingsSection } from '../../../../settings/SettingsSection';
import { SETTINGS_GLASS_PANEL_CLASS } from '../../settings-tab-surface';
import { SYSTEM_DENIED_DESCRIPTION, SYSTEM_DENIED_WHAT_THIS_MEANS } from '../constants';

type Props = {
  paths: readonly string[];
};

export function SystemDeniedPathsCard({ paths }: Props): ReactElement {
  return (
    <SettingsSection title="Always blocked" description={SYSTEM_DENIED_DESCRIPTION}>
      <div id="always-blocked-content" className={SETTINGS_GLASS_PANEL_CLASS}>
        {paths.length === 0 ? (
          <p className="text-xs text-muted-foreground">No system-denied paths configured.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {paths.map((path) => (
              <code
                key={path}
                className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive backdrop-blur-xs"
              >
                {path}
              </code>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">What this means:</span>{' '}
          <code className="rounded bg-muted px-1">.env.example</code>{' '}
          {SYSTEM_DENIED_WHAT_THIS_MEANS}
        </p>
      </div>
    </SettingsSection>
  );
}
