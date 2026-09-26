import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SETTINGS_PANEL_CLASS } from '../dialogs/settings-tabs/settings-tab-surface';

const CARD_CLASS = cn(SETTINGS_PANEL_CLASS, 'overflow-hidden p-0');
const FOOTER_CLASS = 'border-t border-border/40 bg-card/20 px-4 py-3 flex justify-end gap-2';

type SettingsCardProps = {
  children: ReactNode;
};

export function SettingsCard({ children }: SettingsCardProps): ReactElement {
  return <div className={CARD_CLASS}>{children}</div>;
}

type SettingsCardFooterProps = {
  children: ReactNode;
};

export function SettingsCardFooter({ children }: SettingsCardFooterProps): ReactElement {
  return <div className={FOOTER_CLASS}>{children}</div>;
}
