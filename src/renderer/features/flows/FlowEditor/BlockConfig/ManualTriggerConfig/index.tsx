/**
 * Manual trigger: display name (node label).
 */

import { Input } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import { FieldRow } from '../shared';

type Props = {
  node: FlowNode;
  onPatch: (patch: { label?: string }) => void;
};

export function ManualTriggerConfig({ node, onPatch }: Props): ReactElement {
  return (
    <FieldRow htmlFor="flow-manual-label" label="Display name" hint="Shown in the step list.">
      <Input
        id="flow-manual-label"
        value={node.label ?? ''}
        onChange={(e) => onPatch({ label: e.target.value })}
        placeholder="Trigger"
      />
    </FieldRow>
  );
}
