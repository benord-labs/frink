/**
 * The labelled Project row shared by the block configs that wrap the picker in a FieldRow
 * (Start Task, Run Command). CustomNodeConfig renders NodeProjectField bare and does not use this.
 *
 * `nodeId` keys the field so its fixed-vs-variable mode resets when the panel is reused for
 * another node — the config forms are rendered without a key of their own.
 */

import type { ReactElement } from 'react';
import { NodeProjectField } from '../NodeProjectField';
import { FieldRow } from '../shared';

type NodeProjectRowProps = {
  nodeId: string;
  projectId: string;
  flowDefaultProjectId: string | undefined;
  onProjectIdChange: (id: string) => void;
  onOpenFlowSettings?: () => void;
  /** Rendered by FieldRow and mirrored as a ring around the picker. */
  error?: string | null;
  htmlFor?: string;
};

export function NodeProjectRow({
  nodeId,
  projectId,
  flowDefaultProjectId,
  onProjectIdChange,
  onOpenFlowSettings,
  error,
  htmlFor,
}: NodeProjectRowProps): ReactElement {
  return (
    <FieldRow htmlFor={htmlFor} label="Project" error={error}>
      <div className={error ? 'rounded-md ring-2 ring-destructive/50' : undefined}>
        <NodeProjectField
          key={nodeId}
          projectId={projectId}
          flowDefaultProjectId={flowDefaultProjectId}
          onProjectIdChange={onProjectIdChange}
          onOpenFlowSettings={onOpenFlowSettings}
        />
      </div>
    </FieldRow>
  );
}
