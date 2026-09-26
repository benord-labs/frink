/**
 * StateTransitionSection Component
 * Configure status transition conditions for the rule
 */

import { Input } from '@benord-labs/frink-primitives';
import { memo } from 'react';
import { Label } from '../../../../../../components/ui/label';

type Props = {
  fromStatus: string;
  toStatus: string;
  onFromStatusChange: (value: string) => void;
  onToStatusChange: (value: string) => void;
};

const getStatusMessage = (fromStatus: string, toStatus: string): string => {
  if (!toStatus) return 'Triggers for any destination state';
  if (!fromStatus) return `Triggers when status changes to "${toStatus}"`;
  return `Triggers when status changes from "${fromStatus}" to "${toStatus}"`;
};

export const StateTransitionSection = memo(
  ({ fromStatus, toStatus, onFromStatusChange, onToStatusChange }: Props) => (
    <div className="space-y-3 p-4 rounded-lg border border-border bg-muted/30">
      <Label className="text-sm font-medium">Status transition</Label>
      <Input
        aria-label="From workflow state name"
        placeholder="From workflow state name (blank for any)"
        value={fromStatus}
        onChange={(event) => onFromStatusChange(event.target.value)}
      />
      <Input
        aria-label="To workflow state name"
        placeholder="To workflow state name (blank for any)"
        value={toStatus}
        onChange={(event) => onToStatusChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Type the state names exactly as your tool shows them. Leave a box empty to match any state.
      </p>
      <p className="text-xs text-muted-foreground">{getStatusMessage(fromStatus, toStatus)}</p>
    </div>
  ),
);

StateTransitionSection.displayName = 'StateTransitionSection';
