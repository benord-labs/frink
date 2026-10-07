import { useSetAtom } from 'jotai';
import { Plug } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
} from '../../../../../lib/atoms';
import type { ActionMenuProps } from '..';
import { MenuAction } from '../MenuAction';

/** Opens Settings > Models for a task that failed because its account is not connected. */
export function ConnectAccountMenuItem({
  task,
  status,
}: Pick<ActionMenuProps, 'task' | 'status'>): ReactElement {
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  return (
    <MenuAction
      show={status === 'failed' && task.result?.errorAction === 'open-connect-account'}
      icon={Plug}
      label="Connect account"
      onSelect={() => {
        setSettingsActiveTab('models');
        setSettingsOpen(true);
      }}
    />
  );
}
