/**
 * Start Task block configuration.
 * Provisions task environment: project, model, worktree, and branch.
 */

import { Input } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { TRIGGER_START_MODES } from '../../../../../../shared/types/trigger-context';
import { Checkbox } from '../../../../../components/ui/checkbox';
import { Label } from '../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { useProjectModelOptions } from '../../hooks/use-project-model-options';
import { AvailableVariables } from '../AvailableVariables';
import { NodeModelField } from '../NodeModelField';
import { NodeProjectRow } from '../NodeProjectRow';
import { getEffectiveNodeProjectId, getNodeProjectFieldError } from '../node-project-resolution';
import { cfg, FieldRow, type ProjectNodeConfigProps } from '../shared';
import { FlowBranchField } from './FlowBranchField';

export function StartTaskConfig({
  node,
  flowSettings,
  triggerBlockType,
  predecessorBlockType,
  predecessorOfPredecessorBlockType,
  predecessorExpectedOutputs,
  predecessorOfPredecessorExpectedOutputs,
  ancestorFanOut,
  nodeVariables,
  onPatchLabel,
  onConfigPatch,
  onOpenFlowSettings,
}: ProjectNodeConfigProps): ReactElement {
  const c = cfg(node);
  const projectId = typeof c.projectId === 'string' ? c.projectId : '';
  const label = typeof c.label === 'string' ? c.label : '';
  const model = typeof c.model === 'string' ? c.model : '';
  const startMode =
    typeof c.startMode === 'string' &&
    TRIGGER_START_MODES.includes(c.startMode as (typeof TRIGGER_START_MODES)[number])
      ? c.startMode
      : 'execute';
  const startInWorktree = c.startInWorktree === true;
  const branch = typeof c.branch === 'string' ? c.branch : '';

  const flowDefaultModel = flowSettings?.defaultModel;
  const effectiveProjectId = getEffectiveNodeProjectId(projectId, flowSettings?.defaultProjectId);
  const { modelOptions, isCodexProject, modelPlaceholder } = useProjectModelOptions(
    effectiveProjectId,
    { model, flowDefaultModel, onClearModel: () => onConfigPatch({ model: undefined }) },
  );

  const projErr = getNodeProjectFieldError(effectiveProjectId);

  return (
    <div className="space-y-4">
      <FieldRow
        htmlFor="flow-start-task-display-label"
        label="Display name"
        hint="Shown in the step list."
      >
        <Input
          id="flow-start-task-display-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Start task"
        />
      </FieldRow>
      <NodeProjectRow
        htmlFor="flow-start-task-project"
        nodeId={node.id}
        projectId={projectId}
        flowDefaultProjectId={flowSettings?.defaultProjectId}
        onProjectIdChange={(id) => onConfigPatch({ projectId: id })}
        onOpenFlowSettings={onOpenFlowSettings}
        error={projErr}
      />
      <FieldRow htmlFor="flow-start-task-model" label="Model override">
        <NodeModelField
          model={model}
          flowDefaultModel={flowDefaultModel}
          modelOptions={modelOptions}
          isCodexProject={isCodexProject}
          inheritOptionLabel={modelPlaceholder}
          selectId="flow-start-task-model"
          onModelChange={(m) => onConfigPatch({ model: m })}
        />
      </FieldRow>
      <FieldRow
        htmlFor="flow-start-task-label"
        label="Task title (optional)"
        hint="Used as the created task title. When empty, a default title is used."
      >
        <Input
          id="flow-start-task-label"
          value={label}
          onChange={(e) => onConfigPatch({ label: e.target.value })}
          placeholder="Flow: Agent task"
        />
      </FieldRow>
      <FieldRow htmlFor="flow-start-task-mode" label="Start mode">
        <Select value={startMode} onValueChange={(v) => onConfigPatch({ startMode: v })}>
          <SelectTrigger id="flow-start-task-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="execute">Execute</SelectItem>
            <SelectItem value="plan">Plan</SelectItem>
            <SelectItem value="wait">Wait</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 pt-1 items-start">
        <Checkbox
          id="flow-start-task-worktree"
          className="col-start-1 row-start-1 mt-0.5 shrink-0 self-start"
          checked={startInWorktree}
          onCheckedChange={(v) => onConfigPatch({ startInWorktree: v === true })}
        />
        <Label
          htmlFor="flow-start-task-worktree"
          className="col-start-2 row-start-1 min-w-0 text-sm font-normal leading-5 cursor-pointer"
        >
          Start in worktree
        </Label>
        <p className="col-start-2 row-start-2 min-w-0 text-xs text-muted-foreground">
          Creates an isolated git worktree before invoking the agent.
        </p>
      </div>
      {startInWorktree && (
        <FieldRow
          htmlFor="flow-start-task-branch"
          label="Branch from (optional)"
          hint="Which existing branch to create the worktree from (not the new worktree branch name). Leave as default branch or empty for the repo default. Use {{…}} for dynamic values."
        >
          <FlowBranchField
            effectiveProjectId={effectiveProjectId}
            branch={branch}
            htmlFor="flow-start-task-branch"
            onBranchChange={(b) => onConfigPatch({ branch: b })}
          />
        </FieldRow>
      )}
      <AvailableVariables
        triggerBlockType={triggerBlockType}
        predecessorBlockType={predecessorBlockType}
        predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
        predecessorExpectedOutputs={predecessorExpectedOutputs}
        predecessorOfPredecessorExpectedOutputs={predecessorOfPredecessorExpectedOutputs}
        ancestorFanOut={ancestorFanOut}
        nodeVariables={nodeVariables}
      />
    </div>
  );
}
