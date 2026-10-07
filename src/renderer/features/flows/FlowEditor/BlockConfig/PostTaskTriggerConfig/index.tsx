/* eslint-disable max-lines, max-lines-per-function */
/**
 * Post-task trigger: graph config + cloud binding for project-scoped automation.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { type ReactElement, useMemo } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import type { PostTaskTriggerState } from '../../../../../../shared/types/flow';
import { Checkbox } from '../../../../../components/ui/checkbox';
import { Label } from '../../../../../components/ui/label';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';
import { BLOCK_CONFIG_CALLOUT_CLASS } from '../block-config-chrome';
import { FlowProjectField } from '../FlowProjectField';
import { FieldRow } from '../shared';
import { toastTriggerBindingMutationError } from '../triggerBindingToasts';

const TRIGGER_STATE_OPTIONS: { id: PostTaskTriggerState; label: string }[] = [
  { id: 'done', label: 'Done' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'needs_attention', label: 'Needs attention' },
  { id: 'plan_ready', label: 'Plan ready' },
  { id: 'all', label: 'All statuses' },
];

const SOURCE_PRESETS = ['manual', 'shortcut', 'slack', 'gmail', 'linear', 'flow'] as const;

function readStates(cfg: Record<string, unknown> | undefined): PostTaskTriggerState[] {
  const raw = cfg?.triggerStates;
  if (!Array.isArray(raw)) return ['done', 'completed'];
  const out = raw.filter(
    (x): x is PostTaskTriggerState =>
      typeof x === 'string' && TRIGGER_STATE_OPTIONS.some((o) => o.id === x),
  );
  return out.length > 0 ? out : ['done', 'completed'];
}

function readSources(cfg: Record<string, unknown> | undefined): string {
  const raw = cfg?.filterBySource;
  if (typeof raw === 'string') return raw.trim();
  if (!Array.isArray(raw)) return '';
  return raw.filter((x): x is string => typeof x === 'string').join(', ');
}

function readFilterArray(cfg: Record<string, unknown> | undefined): string[] | undefined {
  const raw = cfg?.filterBySource;
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

/** A binding with no project can never match a task, so say so beside any recorded error. */
function BindingWarnings({
  projectId,
  lastError,
}: {
  projectId: string | null;
  lastError: string | null;
}): ReactElement {
  return (
    <>
      {!projectId?.trim() ? (
        <p className="text-xs text-destructive">
          This automation has no project, so it will never fire. Remove it and enable it again with
          a project.
        </p>
      ) : null}
      {lastError ? <p className="text-xs text-destructive">{lastError}</p> : null}
    </>
  );
}

type Props = {
  flowId: string;
  flowProjectId: string | null;
  node: FlowNode;
  onPatchLabel: (patch: { label?: string }) => void;
  onPatchConfig: (config: Record<string, unknown>) => void;
};

export function PostTaskTriggerConfig({
  flowId,
  flowProjectId,
  node,
  onPatchLabel,
  onPatchConfig,
}: Props): ReactElement {
  const cfg = node.config;
  const states = readStates(cfg);
  const sourcesLine = readSources(cfg);
  const filterArr = readFilterArray(cfg);
  const bindingProjectId =
    typeof cfg?.bindingProjectId === 'string' && cfg.bindingProjectId.trim()
      ? cfg.bindingProjectId.trim()
      : (flowProjectId ?? '');

  const utils = trpc.useUtils();
  const { data: bindings, isLoading } = trpc.triggerBindings.list.useQuery({ flowId });

  const postBinding = useMemo(
    () => bindings?.find((b) => b.triggerType === 'post_task_trigger') ?? null,
    [bindings],
  );

  const createMut = trpc.triggerBindings.create.useMutation({
    onSuccess: () => void utils.triggerBindings.list.invalidate({ flowId }),
    onError: toastTriggerBindingMutationError,
  });
  const deleteMut = trpc.triggerBindings.delete.useMutation({
    onSuccess: () => void utils.triggerBindings.list.invalidate({ flowId }),
    onError: toastTriggerBindingMutationError,
  });
  const updateMut = trpc.triggerBindings.update.useMutation({
    onSuccess: () => void utils.triggerBindings.list.invalidate({ flowId }),
    onError: toastTriggerBindingMutationError,
  });

  const toggleState = (id: PostTaskTriggerState, checked: boolean): void => {
    let next: PostTaskTriggerState[];
    if (id === 'all') {
      next = checked ? ['all'] : ['done', 'completed'];
    } else {
      const withoutAll = states.filter((s) => s !== 'all');
      const base = checked ? [...withoutAll, id] : withoutAll.filter((s) => s !== id);
      next = base.length === 0 ? ['done', 'completed'] : base;
    }
    onPatchConfig({ triggerStates: next, filterBySource: filterArr });
  };

  const onSourcesChange = (value: string): void => {
    const parts = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onPatchConfig({ triggerStates: states, filterBySource: parts });
  };

  const setBindingProject = (id: string): void => {
    onPatchConfig({
      triggerStates: states,
      filterBySource: filterArr,
      bindingProjectId: id,
    });
  };

  const bindingConfigPayload = (): Record<string, unknown> => ({
    triggerStates: states,
    ...(filterArr && filterArr.length > 0 ? { filterBySource: filterArr } : {}),
  });

  return (
    <div className="flex flex-col gap-4">
      <FieldRow htmlFor="flow-post-task-label" label="Display name" hint="Shown in the step list.">
        <Input
          id="flow-post-task-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Post-task trigger"
        />
      </FieldRow>

      <div className="space-y-2">
        <Label className="text-sm font-medium">When task status becomes</Label>
        <div className="flex flex-col gap-2 pl-1">
          {TRIGGER_STATE_OPTIONS.map(({ id, label }) => {
            const cid = `flow-pt-state-${id}`;
            return (
              <div key={id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={cid}
                  checked={states.includes(id)}
                  onCheckedChange={(v) => toggleState(id, v === true)}
                />
                <Label htmlFor={cid} className="font-normal cursor-pointer">
                  {label}
                </Label>
              </div>
            );
          })}
        </div>
      </div>

      <FieldRow
        htmlFor="flow-post-task-sources"
        label="Filter by source (optional)"
        hint={`Comma-separated. Examples: ${SOURCE_PRESETS.join(', ')}. Leave empty for any source.`}
      >
        <Input
          id="flow-post-task-sources"
          value={sourcesLine}
          onChange={(e) => onSourcesChange(e.target.value)}
          placeholder="manual, slack"
        />
      </FieldRow>

      <div className="border-t border-border/60 pt-3 space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Available context for downstream blocks
        </p>
        <div className={cn(BLOCK_CONFIG_CALLOUT_CLASS, 'space-y-1')}>
          {[
            { label: 'trigger.taskTitle', hint: 'Title of the completed task' },
            { label: 'trigger.taskStatus', hint: 'Final status (completed, failed…)' },
            { label: 'trigger.result', hint: 'Task result payload' },
            { label: 'trigger.worktreePath', hint: 'Worktree path (if task ran in a worktree)' },
            { label: 'trigger.branch', hint: 'Branch checked out in the worktree' },
            { label: 'trigger.chatId', hint: 'Originating chat ID' },
            { label: 'trigger.projectPath', hint: 'Project directory on disk' },
          ].map(({ label, hint }) => (
            <div key={label} className="flex items-baseline gap-2 text-xs">
              <code className="font-mono text-primary/80 shrink-0">{`{{${label}}}`}</code>
              <span className="text-muted-foreground">{hint}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border/60 pt-3 space-y-3">
        <p className="text-sm font-medium">Cloud automation</p>
        <p className="text-xs text-muted-foreground">
          Bind this flow to a project so it starts when standalone tasks in that project reach the
          statuses above (flow-created tasks are ignored).
        </p>
        <FieldRow
          htmlFor="flow-post-task-binding-project"
          label="Project scope"
          hint="Tasks must belong to this project."
        >
          <FlowProjectField projectId={bindingProjectId} onProjectIdChange={setBindingProject} />
        </FieldRow>

        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading binding…</p>
        ) : postBinding ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="ftb-active"
                checked={postBinding.isActive}
                onCheckedChange={(v) => {
                  updateMut.mutate({ id: postBinding.id, isActive: v === true });
                }}
              />
              <Label htmlFor="ftb-active" className="text-sm font-normal cursor-pointer">
                Automation active
              </Label>
            </div>
            <BindingWarnings projectId={postBinding.projectId} lastError={postBinding.lastError} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={updateMut.isPending}
                onClick={() => {
                  updateMut.mutate({
                    id: postBinding.id,
                    config: bindingConfigPayload(),
                    clearLastError: true,
                  });
                }}
              >
                Sync config to binding
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate({ id: postBinding.id })}
              >
                Remove binding
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={createMut.isPending || !bindingProjectId.trim()}
            onClick={() => {
              createMut.mutate({
                flowId,
                projectId: bindingProjectId.trim(),
                triggerType: 'post_task_trigger',
                config: bindingConfigPayload(),
              });
            }}
          >
            Enable automation
          </Button>
        )}
      </div>
    </div>
  );
}
