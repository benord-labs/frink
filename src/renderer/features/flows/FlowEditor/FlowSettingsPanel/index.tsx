/* eslint-disable max-lines, max-lines-per-function */
/**
 * Flow-level execution settings panel — defaults applied to every node in the flow.
 */

import { Button, Textarea } from '@benord-labs/frink-primitives';
import { FileText, X } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { FlowNode } from '../../../../../shared/lib/validate-flow-graph';
import type { FlowSettings } from '../../../../../shared/types/flow';
import { Label } from '../../../../components/ui/label';
import { Switch } from '../../../../components/ui/switch';
import { useBriefFocusHighlight } from '../../../../hooks/use-brief-focus-highlight';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';
import { ModelSelector } from '../../../agents/components/model-selector';
import { FlowProjectField } from '../BlockConfig/FlowProjectField';
import { flowModelVariant, getFlowPickerModels } from '../hooks/flow-picker-models';
import { useProjectModelOptions } from '../hooks/use-project-model-options';
import { BatchTriggerVariables } from './BatchTriggerVariables';
import { BriefingStashControls } from './BriefingStashControls';
import { FlowSpeedSettings } from './FlowSpeedSettings';
import { patch } from './patch';

type Props = {
  flowId: string;
  flowName: string;
  flowDescription: string | null;
  isEnabled: boolean;
  /** When true, agents may start runs via MCP (frink_flows_run). */
  agentInvocable: boolean;
  settings: FlowSettings | undefined;
  /** The graph's steps; Ultrafast is offered when any of their models supports it. */
  nodes: readonly FlowNode[];
  onSettingsChange: (settings: FlowSettings) => void;
  /** Forwarded to BriefingStashControls to trigger a flow save after stashing. */
  onAfterStash?: () => void;
  onClose: () => void;
  /** Block type of the trigger node — used to gate the Batch Variables section (manual_trigger only). */
  triggerBlockType?: string;
  /** Active batch ID — used to fetch detected trigger variables from runs. */
  currentBatchId?: string | null;
  /** Bumped by node missing-project deep-links; scrolls to + highlights the Project field. */
  focusProjectNonce?: number;
};

function normalizeDescription(value: string): string | null {
  const t = value.trim();
  return t.length === 0 ? null : t;
}

export function FlowSettingsPanel({
  flowId,
  flowName,
  flowDescription,
  isEnabled,
  agentInvocable,
  settings,
  nodes,
  onSettingsChange,
  onAfterStash,
  onClose,
  triggerBlockType,
  currentBatchId,
  focusProjectNonce,
}: Props): ReactElement {
  const { ref: projectSectionRef, highlighted: projectHighlighted } =
    useBriefFocusHighlight<HTMLDivElement>(focusProjectNonce);
  const utils = trpc.useUtils();
  const [descDraft, setDescDraft] = useState(() => flowDescription ?? '');
  const [optimisticEnabled, setOptimisticEnabled] = useState(isEnabled);
  const [optimisticAgentInvocable, setOptimisticAgentInvocable] = useState(agentInvocable);

  useEffect(() => {
    setOptimisticEnabled(isEnabled);
  }, [isEnabled]);

  useEffect(() => {
    setOptimisticAgentInvocable(agentInvocable);
  }, [agentInvocable]);

  useEffect(() => {
    setDescDraft(flowDescription ?? '');
  }, [flowDescription]);

  const updateMetaMutation = trpc.flows.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.flows.get.invalidate({ id: flowId }),
        utils.flows.list.invalidate(),
      ]);
    },
    onError: (err) => {
      toast.error(err.message || 'Could not update flow');
    },
  });

  const projectId = settings?.defaultProjectId ?? '';
  const defaultModelId = settings?.defaultModel?.trim() ?? '';

  const { isCodexProject } = useProjectModelOptions(projectId.trim() ? projectId : undefined, {
    model: settings?.defaultModel,
    onClearModel: () => onSettingsChange(patch(settings, { defaultModel: undefined })),
  });
  const availableModels = useMemo(() => getFlowPickerModels(isCodexProject), [isCodexProject]);
  const selectedPickerModel = defaultModelId
    ? availableModels.find((m) => m.id === defaultModelId)
    : undefined;
  const staleModelId = defaultModelId && !selectedPickerModel ? defaultModelId : undefined;

  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  return (
    <aside className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-transparent">
      <div className="shrink-0 border-b border-border/40 px-3 pb-2.5 pt-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight" id="flow-settings-title">
              Flow settings
            </h2>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Default project and model. Start mode and worktree are set on each Start Task block.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Close flow settings"
            onClick={onClose}
            iconOnly
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3 scrollbar-thin"
        role="region"
        aria-labelledby="flow-settings-title"
      >
        {/* Flow metadata */}
        <div className="grid gap-1.5">
          <Label htmlFor="flow-settings-description" className="text-xs font-medium">
            Description
          </Label>
          <Textarea
            id="flow-settings-description"
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={() => {
              const next = normalizeDescription(descDraft);
              const prev = normalizeDescription(flowDescription ?? '');
              if (next === prev) return;
              updateMetaMutation.mutate({ id: flowId, description: next });
            }}
            placeholder="Optional — shown in the flows list"
            maxLength={2000}
            rows={3}
            className="min-h-[72px] resize-y border-border/40 bg-background/30 text-sm dark:bg-background/20"
            disabled={updateMetaMutation.isPending}
          />
          <p className="text-[11px] text-muted-foreground">Saved when you leave this field.</p>
        </div>

        <div
          className={cn(
            'space-y-4 rounded-xl border border-border/40 p-3',
            'bg-muted/25 dark:bg-muted/15',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <Label htmlFor="flow-settings-enabled" className="text-xs font-medium">
                Flow enabled
              </Label>
              <p className="text-[11px] text-muted-foreground">
                When off, triggers and new runs are blocked. You can still edit the flow.
              </p>
            </div>
            <Switch
              id="flow-settings-enabled"
              checked={optimisticEnabled}
              disabled={updateMetaMutation.isPending}
              onCheckedChange={(checked) => {
                if (checked === optimisticEnabled) return;
                setOptimisticEnabled(checked);
                updateMetaMutation.mutate(
                  // biome-ignore lint/style/useNamingConvention: DB field name
                  { id: flowId, is_enabled: checked },
                  { onError: () => setOptimisticEnabled(!checked) },
                );
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <Label htmlFor="flow-settings-agent-invocable" className="text-xs font-medium">
                Allow agents to run this flow
              </Label>
              <p className="text-[11px] text-muted-foreground">
                When on, agents can start this flow without asking. When off, an agent must ask you
                each time — you approve in chat, so you never need to come back here. Triggers,
                schedules and runs you start yourself are never affected, and turning this off does
                not stop runs already in flight; disable the flow for that.
              </p>
            </div>
            <Switch
              id="flow-settings-agent-invocable"
              checked={optimisticAgentInvocable}
              disabled={updateMetaMutation.isPending}
              onCheckedChange={(checked) => {
                if (checked === optimisticAgentInvocable) return;
                setOptimisticAgentInvocable(checked);
                updateMetaMutation.mutate(
                  // biome-ignore lint/style/useNamingConvention: DB field name
                  { id: flowId, agent_invocable: checked },
                  { onError: () => setOptimisticAgentInvocable(!checked) },
                );
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <Label htmlFor="flow-settings-pause-on-failure" className="text-xs font-medium">
                Pause on failure
              </Label>
              <p className="text-[11px] text-muted-foreground">
                When on, a node failure pauses the run instead of terminating it. You can retry or
                skip the failed step to continue.
              </p>
            </div>
            <Switch
              id="flow-settings-pause-on-failure"
              checked={settings?.pauseOnFailure === true}
              onCheckedChange={(checked) =>
                onSettingsChange(patch(settings, { pauseOnFailure: checked || undefined }))
              }
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <Label htmlFor="flow-settings-auto-accept" className="text-xs font-medium">
                Auto-accept completed runs
              </Label>
              <p className="text-[11px] text-muted-foreground">
                When on, a successful run marks its tasks completed immediately. When off, finished
                work waits in Ready for review until you accept it.
              </p>
            </div>
            <Switch
              id="flow-settings-auto-accept"
              checked={settings?.autoAcceptCompletedRuns === true}
              onCheckedChange={(checked) =>
                onSettingsChange(patch(settings, { autoAcceptCompletedRuns: checked || undefined }))
              }
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <Label htmlFor="flow-settings-auto-mode" className="text-xs font-medium">
                Auto Mode
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Let supported providers review eligible approval requests for Agent steps. Direct
                command and custom-node steps are unaffected.
              </p>
            </div>
            <Switch
              id="flow-settings-auto-mode"
              checked={settings?.autoReviewTools !== false}
              onCheckedChange={(checked) =>
                onSettingsChange(patch(settings, { autoReviewTools: checked }))
              }
            />
          </div>

          <FlowSpeedSettings
            settings={settings}
            nodes={nodes}
            onSettingsChange={onSettingsChange}
          />
        </div>

        {/* Project */}
        <div
          ref={projectSectionRef}
          className={cn(
            'grid gap-1.5 rounded-lg transition-shadow duration-300 motion-reduce:transition-none',
            projectHighlighted && 'ring-2 ring-primary/40',
          )}
        >
          <Label className="text-xs font-medium">Project</Label>
          <FlowProjectField
            projectId={projectId}
            onProjectIdChange={(id) =>
              onSettingsChange(patch(settings, { defaultProjectId: id || undefined }))
            }
          />
          <p className="text-[11px] text-muted-foreground">
            All steps in this flow run in this project unless individually overridden.
          </p>
        </div>

        {/* Default model */}
        <div className="grid gap-1.5">
          <Label htmlFor="flow-settings-model" className="text-xs font-medium">
            Default model
          </Label>
          <div className="min-w-0 w-full">
            <ModelSelector
              mode="flow"
              flowInheritLabel="Agent default"
              triggerId="flow-settings-model"
              selectedModel={selectedPickerModel}
              staleModelId={staleModelId}
              availableModels={availableModels}
              onModelChange={(m) => onSettingsChange(patch(settings, { defaultModel: m.id }))}
              onClearModel={() => onSettingsChange(patch(settings, { defaultModel: undefined }))}
              modelVariant={flowModelVariant(isCodexProject)}
              isOpen={modelMenuOpen}
              onOpenChange={setModelMenuOpen}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Individual steps can override this.</p>
        </div>

        {/* Briefing */}
        <BriefingSection
          flowId={flowId}
          flowName={flowName}
          settings={settings}
          onSettingsChange={onSettingsChange}
          onAfterStash={onAfterStash}
        />

        {/* Batch trigger variables — only for manual_trigger flows */}
        {triggerBlockType === 'manual_trigger' && (
          <BatchTriggerVariables
            flowId={flowId}
            batchId={currentBatchId}
            schema={settings?.batchTriggerSchema}
            onChange={(schema) => onSettingsChange(patch(settings, { batchTriggerSchema: schema }))}
          />
        )}
      </div>
    </aside>
  );
}

const BRIEFING_MAX_LENGTH = 10000;

function BriefingSection({
  flowId,
  flowName,
  settings,
  onSettingsChange,
  onAfterStash,
}: {
  flowId: string;
  flowName: string;
  settings: FlowSettings | undefined;
  onSettingsChange: (settings: FlowSettings) => void;
  onAfterStash?: () => void;
}): ReactElement {
  const briefing = settings?.briefing ?? '';
  const isActive = briefing.trim().length > 0;
  const charsRemaining = BRIEFING_MAX_LENGTH - briefing.length;

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="flow-settings-briefing" className="text-xs font-medium">
            Briefing
          </Label>
          {isActive && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              <FileText className="h-2.5 w-2.5" aria-hidden />
              Active
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <BriefingStashControls
            flowId={flowId}
            flowName={flowName}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onAfterStash={onAfterStash}
          />
          {isActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSettingsChange(patch(settings, { briefing: undefined }))}
              className="h-auto px-1 py-0 text-[11px] text-muted-foreground hover:text-destructive"
              aria-label="Clear briefing"
            >
              Clear
            </Button>
          )}
        </div>
      </div>
      <Textarea
        id="flow-settings-briefing"
        value={briefing}
        onChange={(e) => {
          const next = e.target.value;
          onSettingsChange(patch(settings, { briefing: next.length > 0 ? next : undefined }));
        }}
        placeholder="Add shared context for all runs of this flow — a PRD, refactoring spec, or checklist. Delivered once as a system prompt to every agent in the flow, not repeated in each message."
        maxLength={BRIEFING_MAX_LENGTH}
        rows={5}
        className="min-h-[120px] resize-y border-border/40 bg-background/30 font-mono text-sm dark:bg-background/20"
      />
      <p className="text-[11px] text-muted-foreground flex items-center justify-between">
        <span>
          Shared with every agent in the flow via the system prompt — sent once, not per message.
        </span>
        <span className={charsRemaining < 500 ? 'text-warning' : ''}>
          {charsRemaining.toLocaleString()} chars left
        </span>
      </p>
    </div>
  );
}
