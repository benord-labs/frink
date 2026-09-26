/**
 * Run command block configuration.
 */

import { Input, Textarea } from '@benord-labs/frink-primitives';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import type { RunCommandWorkingDir } from '../../../../../../shared/types/flow';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { AvailableVariables } from '../AvailableVariables';
import { NodeProjectRow } from '../NodeProjectRow';
import { getEffectiveNodeProjectId } from '../node-project-resolution';
import { cfg, FieldRow, type ProjectNodeConfigProps } from '../shared';

function expectedOutputsToText(c: Record<string, unknown>): string {
  const eo = c.expectedOutputs;
  if (eo !== undefined && typeof eo === 'object' && eo !== null && !Array.isArray(eo)) {
    try {
      return JSON.stringify(eo, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

export function RunCommandConfig({
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
  const command = typeof c.command === 'string' ? c.command : '';
  const projectId = typeof c.projectId === 'string' ? c.projectId : '';
  const isPostTaskTrigger = triggerBlockType === 'post_task_trigger';
  const triggerWorktreeUnsupported =
    c.workingDirectory === 'trigger_worktree' && !isPostTaskTrigger;

  useEffect(() => {
    if (triggerWorktreeUnsupported) {
      onConfigPatch({ workingDirectory: 'project_root' });
    }
  }, [triggerWorktreeUnsupported, onConfigPatch]);

  const workingDirectory: RunCommandWorkingDir = triggerWorktreeUnsupported
    ? 'project_root'
    : c.workingDirectory === 'trigger_worktree' || c.workingDirectory === 'custom'
      ? c.workingDirectory
      : 'project_root';
  const customPath = typeof c.customPath === 'string' ? c.customPath : '';

  const effectiveProjectId = getEffectiveNodeProjectId(projectId, flowSettings?.defaultProjectId);

  const expectedOutputsTextFromNode = useMemo(() => expectedOutputsToText(c), [c.expectedOutputs]);
  const [expectedOutputsText, setExpectedOutputsText] = useState(() => expectedOutputsToText(c));
  const [expectedOutputsError, setExpectedOutputsError] = useState<string | null>(null);
  useEffect(() => {
    setExpectedOutputsText(expectedOutputsTextFromNode);
    setExpectedOutputsError(null);
  }, [node.id, expectedOutputsTextFromNode]);

  const applyExpectedOutputs = (raw: string): void => {
    setExpectedOutputsText(raw);
    const t = raw.trim();
    if (t === '') {
      setExpectedOutputsError(null);
      onConfigPatch({ expectedOutputs: undefined });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setExpectedOutputsError(
          'Must be a JSON object mapping field names to {type, description}.',
        );
        return;
      }
      for (const [, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          typeof v !== 'object' ||
          v === null ||
          typeof (v as Record<string, unknown>).type !== 'string'
        ) {
          setExpectedOutputsError(
            'Each field must be an object with at least a "type" key (e.g. {"type":"string"}).',
          );
          return;
        }
      }
      setExpectedOutputsError(null);
      onConfigPatch({
        expectedOutputs: parsed as Record<string, { type: string; description?: string }>,
      });
    } catch {
      setExpectedOutputsError('Invalid JSON.');
    }
  };

  const cmdErr = command.trim() === '' ? 'Command is required.' : null;
  const projErr = (effectiveProjectId?.trim() ?? '') === '' ? 'Select a project.' : null;
  const customPathErr =
    workingDirectory === 'custom' && customPath.trim() === '' ? 'Custom path is required.' : null;

  return (
    <div className="space-y-4">
      <FieldRow
        htmlFor="flow-run-command-label"
        label="Display name"
        hint="Shown in the step list."
      >
        <Input
          id="flow-run-command-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Run command"
        />
      </FieldRow>
      <FieldRow htmlFor="flow-run-cmd" label="Command" error={cmdErr}>
        <Input
          id="flow-run-cmd"
          value={command}
          onChange={(e) => onConfigPatch({ command: e.target.value })}
          placeholder="npm test"
          error={!!cmdErr}
        />
      </FieldRow>
      <NodeProjectRow
        nodeId={node.id}
        projectId={projectId}
        flowDefaultProjectId={flowSettings?.defaultProjectId}
        onProjectIdChange={(id) => onConfigPatch({ projectId: id })}
        onOpenFlowSettings={onOpenFlowSettings}
        error={projErr}
      />
      <FieldRow
        htmlFor="flow-run-cmd-workdir"
        label="Working directory"
        hint="Where the command runs relative to."
      >
        <Select
          value={workingDirectory}
          onValueChange={(v) => onConfigPatch({ workingDirectory: v as RunCommandWorkingDir })}
        >
          <SelectTrigger id="flow-run-cmd-workdir" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project_root">Project root</SelectItem>
            {isPostTaskTrigger && (
              <SelectItem value="trigger_worktree">Trigger worktree</SelectItem>
            )}
            <SelectItem value="custom">Custom path</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      {workingDirectory === 'custom' && (
        <FieldRow
          htmlFor="flow-run-cmd-custompath"
          label="Custom path"
          error={customPathErr}
          hint="Absolute path on the machine executing the command."
        >
          <Input
            id="flow-run-cmd-custompath"
            value={customPath}
            onChange={(e) => onConfigPatch({ customPath: e.target.value })}
            placeholder="/absolute/path/to/dir"
            error={!!customPathErr}
          />
        </FieldRow>
      )}
      <FieldRow
        htmlFor="flow-run-cmd-expected-outputs"
        label="Declared outputs (optional)"
        hint="If this command prints JSON to stdout, declare the expected fields here. Downstream nodes will show them as chips in Available Variables and validate references."
        error={expectedOutputsError}
      >
        <Textarea
          id="flow-run-cmd-expected-outputs"
          value={expectedOutputsText}
          onChange={(e) => applyExpectedOutputs(e.target.value)}
          placeholder={'{\n  "myField": { "type": "string", "description": "..." }\n}'}
          rows={4}
          className={`font-mono text-xs ${expectedOutputsError ? 'border-destructive' : ''}`}
        />
      </FieldRow>
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
