/**
 * Approval block configuration.
 */

import { Input, Textarea } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import { cfg, FieldRow } from '../shared';

type Props = {
  node: FlowNode;
  onPatchLabel: (patch: { label?: string }) => void;
  onConfigPatch: (config: Record<string, unknown>) => void;
};

export function ApprovalConfig({ node, onPatchLabel, onConfigPatch }: Props): ReactElement {
  const c = cfg(node);
  const message = typeof c.message === 'string' ? c.message : '';

  return (
    <div className="space-y-4">
      <FieldRow htmlFor="flow-approval-label" label="Display name" hint="Shown in the step list.">
        <Input
          id="flow-approval-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Approval"
        />
      </FieldRow>
      <FieldRow
        htmlFor="flow-approval-msg"
        label="Message"
        hint="Shown when the flow pauses for approval."
      >
        <Textarea
          id="flow-approval-msg"
          value={message}
          onChange={(e) => onConfigPatch({ message: e.target.value })}
          placeholder="Approval required"
          rows={4}
        />
      </FieldRow>
    </div>
  );
}
