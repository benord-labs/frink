/**
 * AssigneeSection Component
 * Configure assignee filtering for the rule
 */

import { Button } from '@benord-labs/frink-primitives';
import { User } from 'lucide-react';
import { memo } from 'react';
import { Label } from '../../../../../../components/ui/label';
import { LONG_STRINGS } from '../../../../../../lib/flows/webhook-trigger/constants';
import type { AssigneeMode } from '../../../../../../lib/flows/webhook-trigger/types';

/** Webhook-only plugins deliver events without an account, so Frink cannot match "me". */
const NO_IDENTITY =
  "Frink doesn't know which account is yours for this plugin, so Me isn't available.";

function assigneeHint(assigneeMode: AssigneeMode, supportsMe: boolean, account?: string): string {
  if (!supportsMe) {
    return assigneeMode === 'me'
      ? `${NO_IDENTITY} This saved rule won't run until you choose Anyone.`
      : `Triggers for any assignee. ${NO_IDENTITY}`;
  }
  if (assigneeMode !== 'me') return 'Triggers for any assignee';
  return account
    ? `Only triggers when assigned to @${account}`
    : LONG_STRINGS.assigneeMeDescription;
}

type Props = {
  assigneeMode: AssigneeMode;
  supportsMe: boolean;
  onAssigneeModeChange: (mode: AssigneeMode) => void;
  /** The connected account identifier (e.g., Shortcut username) */
  accountIdentifier?: string;
};

export const AssigneeSection = memo(
  ({ assigneeMode, supportsMe, onAssigneeModeChange, accountIdentifier }: Props) => (
    <div className="space-y-3 p-4 rounded-lg border border-border bg-muted/30">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4 text-muted-foreground" />
        <Label className="text-sm font-medium">Assigned to</Label>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant={assigneeMode === 'me' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onAssigneeModeChange('me')}
          disabled={!supportsMe}
        >
          Me
        </Button>
        <Button
          type="button"
          variant={assigneeMode === 'anyone' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onAssigneeModeChange('anyone')}
        >
          Anyone
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {assigneeHint(assigneeMode, supportsMe, accountIdentifier)}
      </p>
    </div>
  ),
);

AssigneeSection.displayName = 'AssigneeSection';
