import type { ReactElement } from 'react';
import { SettingsTabHeader } from '../../SettingsTabHeader';
import { PERMISSIONS_SUBTITLE } from '../constants';

export function PermissionsHeader(): ReactElement {
  return <SettingsTabHeader title="Permissions" description={PERMISSIONS_SUBTITLE} />;
}
