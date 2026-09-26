/**
 * Per-run detail view shown when a run is selected in StageRunList.
 * Allows editing trigger_context (label, customInstructions, attachments) and reassigning
 * the run to a different stage. Only editable for pending runs.
 */

import { Button, Textarea } from '@benord-labs/frink-primitives';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import type { BatchStageRunRow } from '../../../../../../shared/types/flow';
import type { RunAttachment } from '../../../../../../shared/types/run-attachment';
import { trpc } from '../../../../../lib/trpc';
import { RunAttachmentsSection } from './RunAttachmentsSection';
import { RunBranchSection, RunConflictCallout } from './RunBranchSections';
import { overlayGlass } from '@/lib/overlay-styles';
import {
  deriveRunLabel,
  formatTriggerKey,
  formatTriggerValue,
  runDisplayStatus,
  SYSTEM_TRIGGER_KEYS,
} from './utils';

type RunDetailPanelProps = {
  flowId: string;
  run: BatchStageRunRow;
  runIndex: number;
  stages: BatchStageDetail[];
  currentStageId: string;
  onBack: () => void;
  onReassigned: (sourceStageId: string, targetStageId: string) => void;
};

const DEBOUNCE_MS = 800;

export function RunDetailPanel({
  flowId,
  run,
  runIndex,
  stages,
  currentStageId,
  onBack,
  onReassigned,
}: RunDetailPanelProps): ReactElement {
  const isPending = run.status === 'pending';
  const label = deriveRunLabel(run.trigger_context, runIndex);
  const ctx = run.trigger_context ?? {};
  const contextEntries = Object.entries(ctx).filter(([key]) => !SYSTEM_TRIGGER_KEYS.has(key));
  const initialInstructions =
    typeof ctx.customInstructions === 'string' ? ctx.customInstructions : '';

  const initialAttachments: RunAttachment[] = Array.isArray(ctx.attachments)
    ? (ctx.attachments as RunAttachment[])
    : [];
  const [attachments, setAttachments] = useState<RunAttachment[]>(initialAttachments);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showReassign, setShowReassign] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRunIdRef = useRef(run.id);
  const utils = trpc.useUtils();

  const updateRun = trpc.flows.updateStageRun.useMutation({
    onSuccess: (_data, variables) => {
      void utils.flows.listBatchStageRuns.invalidate({ flowId });
      if (variables.runId !== activeRunIdRef.current) return;
      setSaveError(null);
    },
    onError: (err, variables) => {
      if (variables.runId !== activeRunIdRef.current) return;
      setSaveError(err.message);
    },
    onSettled: (_data, _err, variables) => {
      if (variables.runId !== activeRunIdRef.current) return;
      setIsSaving(false);
    },
  });

  const reassignRun = trpc.flows.reassignStageRun.useMutation({
    onSuccess: (data) => {
      void utils.flows.listBatchStageRuns.invalidate({ flowId });
      onReassigned(data.sourceStageId, data.targetStageId);
    },
  });

  useEffect(() => {
    activeRunIdRef.current = run.id;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
    setIsSaving(false);
    setSaveError(null);
    setInstructions(initialInstructions);
    setAttachments(Array.isArray(ctx.attachments) ? (ctx.attachments as RunAttachment[]) : []);
  }, [run.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInstructionsChange = (value: string) => {
    setInstructions(value);
    clearTimeout(debounceRef.current);
    if (!isPending) return;
    debounceRef.current = setTimeout(() => {
      setIsSaving(true);
      updateRun.mutate({ flowId, runId: run.id, customInstructions: value });
    }, DEBOUNCE_MS);
  };

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const otherStages = stages.filter((s) => s.id !== currentStageId);

  return (
    <div className="flex flex-col h-full">
      {/* Back header */}
      <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-2 shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="w-6 p-0"
          onClick={onBack}
          aria-label="Back to run list"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <span className="text-[11px] font-medium text-foreground/80 truncate flex-1" title={label}>
          {label}
        </span>
        {!isPending && (
          <span
            className={`text-[10px] capitalize shrink-0 ${
              runDisplayStatus(run).warn ? 'text-warning' : 'text-muted-foreground/60'
            }`}
          >
            {runDisplayStatus(run).label}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-4 overflow-y-auto flex-1 px-4 py-3">
        <RunConflictCallout run={run} />
        <RunBranchSection run={run} />

        {/* Dynamic trigger context variables */}
        {contextEntries.map(([key, value]) => (
          <div key={key} className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
              {formatTriggerKey(key)}
            </span>
            <span className="text-[12px] text-foreground/80 break-all">
              {formatTriggerValue(value)}
            </span>
          </div>
        ))}

        {/* Custom instructions */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
              Custom Instructions
            </span>
            {isSaving && (
              <span className="text-[10px] text-muted-foreground/40 italic">Saving…</span>
            )}
            {saveError && (
              <span className="text-[10px] text-destructive/70 italic">Failed to save</span>
            )}
          </div>
          <Textarea
            className="w-full rounded border border-border/50 bg-muted/30 px-2.5 py-2 text-[12px] text-foreground/90 placeholder:text-muted-foreground/40 resize-none focus:outline-hidden focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
            rows={5}
            placeholder={isPending ? 'Add instructions for this run…' : 'No custom instructions'}
            value={instructions}
            onChange={(e) => handleInstructionsChange(e.target.value)}
            disabled={!isPending}
          />
        </div>

        {/* Attachments */}
        <RunAttachmentsSection
          flowId={flowId}
          runId={run.id}
          attachments={attachments}
          isPending={isPending}
          onAttachmentsChange={setAttachments}
        />

        {/* Stage reassignment — pending only */}
        {isPending && otherStages.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
              Move to Stage
            </span>
            <div className="relative">
              <Button
                variant="ghost"
                size="auto"
                className="w-full justify-start text-left font-normal flex justify-between rounded border border-border/50 bg-muted/30 px-2.5 py-1.5 text-[12px] text-foreground/80"
                onClick={() => setShowReassign((v) => !v)}
                aria-expanded={showReassign}
                disabled={reassignRun.isPending}
              >
                <span>Select a stage…</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground/60 shrink-0" aria-hidden />
              </Button>
              {showReassign && (
                <ul
                  className={`absolute z-10 mt-1 w-full rounded border shadow-md max-h-48 overflow-y-auto ${overlayGlass}`}
                >
                  {otherStages.map((s) => (
                    <li key={s.id}>
                      <Button
                        variant="ghost"
                        size="auto"
                        className="w-full justify-start text-left font-normal flex gap-2 rounded-none px-2.5 py-2 text-[12px] text-foreground/80"
                        onClick={() => {
                          setShowReassign(false);
                          reassignRun.mutate({ flowId, runId: run.id, targetStageId: s.id });
                        }}
                      >
                        <span className="text-[10px] tabular-nums text-muted-foreground/50 shrink-0">
                          {s.stage_number}
                        </span>
                        <span className="truncate">{s.name ?? `Stage ${s.stage_number}`}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {reassignRun.isError && (
              <span className="text-[10px] text-destructive/70">{reassignRun.error.message}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
