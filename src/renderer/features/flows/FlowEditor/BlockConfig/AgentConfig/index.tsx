/* eslint-disable max-lines, max-lines-per-function */
/**
 * Agent block configuration.
 * Instructions + optional model override and follow-up worktree reuse.
 * Project, default model, and worktree provisioning live in the upstream Start Task.
 */

import { Button, Textarea } from '@benord-labs/frink-primitives';
import { ChevronDown } from 'lucide-react';
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { SlashCommandOption } from '@/lib/commands/types';
import { RECOMMENDED_AGENT_PROMPT_TEMPLATES } from '../../../../../../shared/lib/recommended-prompt-templates';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import type { FlowSettings } from '../../../../../../shared/types/flow';
import { Checkbox } from '../../../../../components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../../components/ui/dropdown-menu';
import { Label } from '../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import {
  AgentsSlashCommand,
  SLASH_COMMAND_LISTBOX_ID,
} from '../../../../../features/agents/commands/agents-slash-command';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';
import { useProjectModelOptions } from '../../hooks/use-project-model-options';
import { useProjectPath } from '../../hooks/use-project-path';
import { AvailableVariables } from '../AvailableVariables';
import { NodeModelField } from '../NodeModelField';
import { getEffectiveNodeProjectId } from '../node-project-resolution';
import { cfg, FieldRow, isProjectRow, type UpstreamContextProps } from '../shared';
import { TemplateHighlightContainer } from '../shared/TemplateHighlightContainer';
import { useTextareaSlashDetection } from '../shared/use-textarea-slash-detection';
import {
  INSTRUCTIONS_COUNT_ID,
  InstructionsLengthCounter,
  useCappedInstructionsPatch,
} from './InstructionsLengthCounter';

const UNEXPANDED_CMD_RE = /^\/\S+/;

type Props = UpstreamContextProps & {
  node: FlowNode;
  flowSettings: FlowSettings | undefined;
  webhookTriggerIntegrationId?: string;
  customNodesLoading?: boolean;
  predecessorIsCustomNode?: boolean;
  onConfigPatch: (config: Record<string, unknown>) => void;
};

/** Mode for this step only, plus the plan auto-approve and debug notes that depend on it. */
function AgentModeField({
  node,
  onConfigPatch,
}: {
  node: FlowNode;
  onConfigPatch: Props['onConfigPatch'];
}): ReactElement {
  const config = cfg(node);
  // Per-node mode overrides the inherited Start Task mode for this node only. '' = inherit.
  const mode =
    config.mode === 'agent' || config.mode === 'plan' || config.mode === 'debug' ? config.mode : '';
  const autoApprove = config.autoApprove === true;
  return (
    <>
      <FieldRow
        htmlFor="flow-agent-mode"
        label="Mode"
        hint="Plan pauses for your approval before acting. Debug investigates a bug with you (local runs only)."
      >
        <Select
          value={mode || 'inherit'}
          onValueChange={(v) => onConfigPatch({ mode: v === 'inherit' ? undefined : v })}
        >
          <SelectTrigger id="flow-agent-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">Inherit from Start Task</SelectItem>
            <SelectItem value="agent">Agent (execute)</SelectItem>
            <SelectItem value="plan">Plan</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      {mode === 'plan' ? (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 items-start">
          <Checkbox
            id="flow-agent-auto-approve"
            className="col-start-1 row-start-1 mt-0.5 shrink-0 self-start"
            checked={autoApprove}
            onCheckedChange={(v) => onConfigPatch({ autoApprove: v === true })}
          />
          <Label
            htmlFor="flow-agent-auto-approve"
            className="col-start-2 row-start-1 min-w-0 text-sm font-normal leading-5 cursor-pointer"
          >
            Auto-approve the plan
          </Label>
          <p className="col-start-2 row-start-2 min-w-0 text-sm text-muted-foreground">
            Skips the approval pause — the flow advances straight to the next step. Leave off to
            review and approve the plan in the flow run panel before execution.
          </p>
        </div>
      ) : null}
      {mode === 'debug' ? (
        <p className="text-sm text-warning">
          Debug mode runs an interactive hypothesis-driven session: the agent instruments code and
          asks you to reproduce the bug. It requires <span className="font-medium">local</span>{' '}
          execution (the Start Task target must be local) and always pauses for a human.
        </p>
      ) : null}
    </>
  );
}

export function AgentConfig({
  node,
  flowSettings,
  triggerBlockType,
  webhookTriggerIntegrationId,
  predecessorBlockType,
  predecessorOfPredecessorBlockType,
  predecessorExpectedOutputs,
  predecessorOfPredecessorExpectedOutputs,
  ancestorFanOut,
  nodeVariables,
  customNodesLoading = false,
  predecessorIsCustomNode = false,
  onConfigPatch,
}: Props): ReactElement {
  const c = cfg(node);
  const instructions = typeof c.instructions === 'string' ? c.instructions : '';
  const instructionsCommandName =
    typeof c.instructionsCommandName === 'string' ? c.instructionsCommandName : '';
  const fireAndForget = c.fireAndForget === true;
  const model = typeof c.model === 'string' ? c.model : '';

  const flowDefaultProjectId = flowSettings?.defaultProjectId;
  const flowDefaultModel = flowSettings?.defaultModel;
  const effectiveProjectId = getEffectiveNodeProjectId('', flowDefaultProjectId);

  const { data: allProjects } = trpc.projects.list.useQuery();
  const { data: integrations } = trpc.integrations.list.useQuery(undefined, {
    enabled: triggerBlockType === 'webhook_trigger' && Boolean(webhookTriggerIntegrationId),
  });

  const sortedRecommendedTemplates = useMemo(() => {
    const list = [...RECOMMENDED_AGENT_PROMPT_TEMPLATES];
    if (triggerBlockType !== 'webhook_trigger' || !webhookTriggerIntegrationId || !integrations) {
      return list;
    }
    const selected = integrations.find((i) => i.id === webhookTriggerIntegrationId);
    const provider =
      selected && typeof selected.provider === 'string' ? selected.provider.toLowerCase() : '';
    if (!provider) return list;
    return list.sort((a, b) => {
      const ar = a.suggestedForSources?.includes(provider) ? 0 : 1;
      const br = b.suggestedForSources?.includes(provider) ? 0 : 1;
      return ar - br;
    });
  }, [triggerBlockType, webhookTriggerIntegrationId, integrations]);
  const flowProjectName = useMemo((): string | null => {
    if (!flowDefaultProjectId) return null;
    const list = Array.isArray(allProjects) ? allProjects : [];
    const found = list.find((p) => isProjectRow(p) && p.id === flowDefaultProjectId);
    return found && isProjectRow(found) ? found.name : null;
  }, [flowDefaultProjectId, allProjects]);

  const { modelOptions, isCodexProject, modelPlaceholder } = useProjectModelOptions(
    effectiveProjectId,
    { model, flowDefaultModel, onClearModel: () => onConfigPatch({ model: undefined }) },
  );

  const instErr = instructions.trim() === '' ? 'Instructions are required to run this step.' : null;

  const projectPath = useProjectPath(effectiveProjectId ?? '');

  const patchInstructionsWithinCap = useCappedInstructionsPatch(instructions, onConfigPatch);

  const handleInstructionsChange = useCallback(
    (value: string) => {
      patchInstructionsWithinCap(value, '');
    },
    [patchInstructionsWithinCap],
  );

  const [activeDescendantId, setActiveDescendantId] = useState<string | undefined>(undefined);

  const {
    textareaRef,
    slashState,
    handleTextChange,
    handleKeyDown,
    handleTextareaSelect,
    closeSlash,
  } = useTextareaSlashDetection(handleInstructionsChange);

  const insertTemplateAtCursor = useCallback(
    (body: string) => {
      const ta = textareaRef.current;
      const start = ta?.selectionStart ?? instructions.length;
      const end = ta?.selectionEnd ?? instructions.length;
      const before = instructions.slice(0, start);
      const after = instructions.slice(end);
      const sep = '\n\n';
      const needsLead = before.length > 0 && !before.endsWith('\n');
      const needsTrail = after.length > 0 && !after.startsWith('\n');
      const insertion = `${needsLead ? sep : ''}${body}${needsTrail ? sep : ''}`;
      if (!patchInstructionsWithinCap(before + insertion + after, '')) return;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        const pos = start + insertion.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [instructions, patchInstructionsWithinCap, textareaRef],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommandOption) => {
      if (!slashState.active) return;
      const prompt = command.prompt;
      if (!prompt || prompt.trim() === '') {
        toast.error('Could not load command content. The command file may be empty.');
        closeSlash();
        return;
      }
      const { query, slashStart } = slashState;
      const before = instructions.slice(0, slashStart);
      const after = instructions.slice(slashStart + 1 + query.length);
      patchInstructionsWithinCap(before + prompt + after, command.name);
      closeSlash();
    },
    [instructions, slashState, patchInstructionsWithinCap, closeSlash],
  );

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="flow-agent-instructions" className="text-sm font-medium">
            Instructions
          </Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="secondary" size="sm" className="h-7 gap-1">
                Insert template
                <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-[280px]">
              {sortedRecommendedTemplates.map((t) => (
                <DropdownMenuItem key={t.id} onClick={() => insertTemplateAtCursor(t.body)}>
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <TemplateHighlightContainer
          value={instructions}
          nodeVariables={nodeVariables}
          customNodesLoading={customNodesLoading}
          predecessorIsCustomNode={predecessorIsCustomNode}
          textareaId="flow-agent-instructions"
          aria-invalid={instErr ? true : undefined}
          aria-describedby={
            [
              instErr ? 'flow-agent-instructions-error' : '',
              'flow-agent-instructions-hint',
              INSTRUCTIONS_COUNT_ID,
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
        >
          <Textarea
            ref={textareaRef}
            id="flow-agent-instructions"
            value={instructions}
            onChange={handleTextChange}
            onSelect={handleTextareaSelect}
            onKeyDown={handleKeyDown}
            placeholder="What the agent should do"
            className={cn('min-h-40', instErr && 'border-destructive')}
            role="combobox"
            aria-expanded={slashState.active}
            aria-controls={slashState.active ? SLASH_COMMAND_LISTBOX_ID : undefined}
            aria-activedescendant={activeDescendantId}
            aria-autocomplete="list"
          />
        </TemplateHighlightContainer>
        {instErr ? (
          <p id="flow-agent-instructions-error" role="alert" className="text-sm text-destructive">
            {instErr}
          </p>
        ) : null}
        <InstructionsLengthCounter instructions={instructions} />
        <p id="flow-agent-instructions-hint" className="text-sm text-muted-foreground">
          Use {'{{trigger.*}}'}, {'{{previous.*}}'} and {'{{loop.*}}'} to pull in earlier results.
          The flow briefing is added automatically.
        </p>
        {instructionsCommandName && (
          <div className="flex items-center gap-1.5">
            <span
              className="command-input-highlight text-xs text-foreground/70"
              data-command-highlight={instructionsCommandName}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onConfigPatch({ instructionsCommandName: '' })}
              className="text-xs"
              aria-label="Remove command source"
            >
              ×
            </Button>
          </div>
        )}
        {UNEXPANDED_CMD_RE.test(instructions) && !instructionsCommandName && (
          <p className="text-sm text-warning">Select a command from the dropdown to expand it.</p>
        )}
        <AgentsSlashCommand
          isOpen={slashState.active}
          onClose={closeSlash}
          onSelect={handleCommandSelect}
          searchText={slashState.active ? slashState.query : ''}
          position={slashState.active ? slashState.position : { top: 0, left: 0 }}
          projectPath={projectPath}
          hideBuiltins
          onActiveDescendantChange={setActiveDescendantId}
        />
      </div>
      <FieldRow
        htmlFor="flow-agent-model"
        label="Model override"
        hint={flowProjectName ? `Models available in ${flowProjectName}` : undefined}
      >
        <NodeModelField
          model={model}
          flowDefaultModel={flowDefaultModel}
          modelOptions={modelOptions}
          isCodexProject={isCodexProject}
          inheritOptionLabel={modelPlaceholder}
          selectId="flow-agent-model"
          onModelChange={(m) => onConfigPatch({ model: m })}
        />
      </FieldRow>
      {flowDefaultProjectId ? null : (
        <p className="text-sm text-warning">
          No project in Flow settings, so the model list may be limited.
        </p>
      )}
      <AgentModeField node={node} onConfigPatch={onConfigPatch} />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 pt-1 items-start">
        <Checkbox
          id="flow-agent-fire-forget"
          className="col-start-1 row-start-1 mt-0.5 shrink-0 self-start"
          checked={fireAndForget}
          onCheckedChange={(v) => onConfigPatch({ fireAndForget: v === true })}
        />
        <Label
          htmlFor="flow-agent-fire-forget"
          className="col-start-2 row-start-1 min-w-0 text-sm font-normal leading-5 cursor-pointer"
        >
          Don&apos;t wait for this agent
        </Label>
        <p className="col-start-2 row-start-2 min-w-0 text-sm text-muted-foreground">
          It runs as its own task with its own chat while the flow moves on. Up to 5 can chain.
        </p>
      </div>
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
