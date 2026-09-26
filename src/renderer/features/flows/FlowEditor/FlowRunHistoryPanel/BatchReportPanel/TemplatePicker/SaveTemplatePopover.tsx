/**
 * SaveTemplatePopover — a small icon button that opens a popover to save
 * the current batch DAG structure as a named template.
 *
 * Only renders when stages.length > 1 (matches the stages section visibility).
 * Extracts only structural fields (stageNumber, name, dependsOn) from stages.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { BookmarkPlus, Check, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { BatchStageDetail } from '../../../../../../../shared/types/flows/flow-batch';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../../../components/ui/popover';
import { trpc } from '../../../../../../lib/trpc';

type Props = {
  flowId: string;
  stages: BatchStageDetail[];
};

/** Extracts only structural fields from BatchStageDetail[], preserving null names. */
function extractTemplateStages(stages: BatchStageDetail[]) {
  return stages.map((s) => ({
    stageNumber: s.stage_number,
    name: s.name ?? null,
    dependsOn: s.depends_on_stage_numbers ?? [],
  }));
}

export function SaveTemplatePopover({ flowId, stages }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();
  const { mutateAsync: createTemplate, isPending } =
    trpc.flows.createBatchPlanTemplate.useMutation();

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setName('');
      setError(null);
      setSaved(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    setError(null);

    try {
      await createTemplate({
        name: trimmed,
        stages: extractTemplateStages(stages),
        sourceFlowId: flowId,
      });
      setSaved(true);
      void utils.flows.listBatchPlanTemplates.invalidate();
      setTimeout(() => setOpen(false), 800);
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Failed to save template';
      // Surface "already exists" as a field-level error
      if (msg.includes('already exists')) {
        setError('A template with this name already exists');
      } else {
        setError(msg);
      }
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded"
          aria-label="Save as template"
          title="Save as template"
        >
          <BookmarkPlus className="h-3 w-3" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3 space-y-2">
        <p className="text-xs font-medium text-foreground">Save as template</p>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Saves stage names and dependencies. Run contexts are not included.
        </p>
        <Input
          ref={inputRef}
          placeholder="Template name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
            if (e.key === 'Escape') setOpen(false);
          }}
          size="xs"
          className="text-xs"
          maxLength={200}
          aria-label="Template name"
        />
        {error && <p className="text-[10px] text-destructive">{error}</p>}
        <Button
          onClick={() => void handleSave()}
          disabled={isPending || saved}
          className="h-auto w-full gap-1.5 rounded px-2 py-1 text-[11px]"
        >
          {isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : saved ? (
            <Check className="h-3 w-3" aria-hidden />
          ) : null}
          {saved ? 'Saved!' : 'Save'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
