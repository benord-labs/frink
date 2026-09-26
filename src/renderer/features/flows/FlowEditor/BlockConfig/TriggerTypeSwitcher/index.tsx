/**
 * Trigger type switcher: dropdown to change between manual_trigger and webhook_trigger.
 */

import type { ReactElement } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import type { FlowBlockType } from '../../../../../../shared/types/flow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { FLOW_BLOCK_LABELS, FLOW_TRIGGER_TYPES } from '../../constants';
import { FieldRow } from '../shared';

const TRIGGER_TYPES_ARRAY: FlowBlockType[] = Array.from(FLOW_TRIGGER_TYPES);

type Props = {
  node: FlowNode;
  onPatchNode: (
    nodeId: string,
    patch: { blockType: FlowBlockType; config?: Record<string, unknown>; label?: undefined },
  ) => void;
};

export function TriggerTypeSwitcher({ node, onPatchNode }: Props): ReactElement {
  const currentType = node.blockType as FlowBlockType;

  const handleChange = (newType: string): void => {
    const blockType = newType as FlowBlockType;
    if (blockType !== currentType && FLOW_TRIGGER_TYPES.has(blockType)) {
      // Reset config and label when switching types. Webhook defaults (e.g. assignee: me) are
      // persisted when the user picks an event in WebhookTriggerConfig — not on an empty config.
      onPatchNode(node.id, { blockType, config: {}, label: undefined });
    }
  };

  return (
    <FieldRow htmlFor="flow-trigger-type" label="Trigger type" hint="Choose how this flow starts.">
      <Select value={currentType} onValueChange={handleChange}>
        <SelectTrigger id="flow-trigger-type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TRIGGER_TYPES_ARRAY.map((type) => (
            <SelectItem key={type} value={type}>
              {FLOW_BLOCK_LABELS[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}
