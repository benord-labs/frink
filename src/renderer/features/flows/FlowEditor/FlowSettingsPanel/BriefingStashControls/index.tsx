/**
 * Stash/restore controls for the flow briefing.
 * Lets users save a named briefing snapshot and restore it to any flow later.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { Archive, ChevronDown, RotateCcw, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import type { FlowSettings } from '../../../../../../shared/types/flow';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../../components/ui/alert-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../../../../../components/ui/popover';
import { trpc } from '../../../../../lib/trpc';
import { formatRelativeTime } from '../../../../../lib/utils/format-time';
import { patch } from '../patch';

type Props = {
  /** Current flow ID — used as source metadata when stashing. */
  flowId: string;
  /** Current flow name — stored as snapshot metadata. */
  flowName: string;
  settings: FlowSettings | undefined;
  onSettingsChange: (settings: FlowSettings) => void;
  /**
   * Called after a briefing is successfully stashed and the in-memory
   * briefing is cleared. Use to trigger a flow save so the clear persists.
   */
  onAfterStash?: () => void;
};

type BriefingStash = {
  id: string;
  name: string;
  content: string;
  // biome-ignore lint/style/useNamingConvention: DB field name
  content_preview: string;
  // biome-ignore lint/style/useNamingConvention: DB field name
  source_flow_id: string | null;
  // biome-ignore lint/style/useNamingConvention: DB field name
  source_flow_name: string | null;
  // biome-ignore lint/style/useNamingConvention: DB field name
  created_at: string;
};

/** Inline name-input popover that fires onConfirm with the entered name. */
function StashNamePopover({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  /** Returns true on success; false keeps the popover open so the user can retry. */
  onConfirm: (name: string) => Promise<boolean>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const success = await onConfirm(trimmed);
      if (success) {
        setOpen(false);
        setName('');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setName('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          className="gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label="Stash briefing"
        >
          <Archive className="h-3 w-3" aria-hidden />
          Stash
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end">
        <p className="mb-2 text-xs font-medium">Name this stash</p>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 200))}
          placeholder="e.g. Epic 579 briefing"
          size="xs"
          className="mb-2 text-xs"
          autoFocus
          maxLength={200}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleConfirm();
            if (e.key === 'Escape') {
              setOpen(false);
              setName('');
            }
          }}
        />
        <div className="flex justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setOpen(false);
              setName('');
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={!name.trim() || saving}
            onClick={() => void handleConfirm()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Single stash row rendered inside the restore dropdown. */
function StashRow({
  stash,
  onRestore,
  onDelete,
}: {
  stash: BriefingStash;
  onRestore: (stash: BriefingStash) => void;
  onDelete: (id: string) => void;
}): ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <div className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 group">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1 min-w-0 h-auto p-0 flex flex-col items-stretch text-left bg-transparent hover:bg-transparent"
          onClick={() => onRestore(stash)}
        >
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate">{stash.name}</span>
            <span className="text-[10px] text-muted-foreground/60 shrink-0">
              {formatRelativeTime(stash.created_at)}
            </span>
          </div>
          {stash.source_flow_name && (
            <div className="text-[10px] text-muted-foreground/60 truncate">
              from {stash.source_flow_name}
            </div>
          )}
          {stash.content_preview && (
            <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
              {stash.content_preview}
            </div>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setConfirmDelete(true)}
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
          aria-label={`Delete stash "${stash.name}"`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete stash?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{stash.name}&rdquo; will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                onDelete(stash.id);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function BriefingStashControls({
  flowId,
  flowName,
  settings,
  onSettingsChange,
  onAfterStash,
}: Props): ReactElement {
  const utils = trpc.useUtils();
  const briefing = settings?.briefing ?? '';
  const isActive = briefing.trim().length > 0;

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<BriefingStash | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const { data: stashes = [], isFetching: stashesLoading } = trpc.flows.listStashes.useQuery(
    undefined,
    { enabled: restoreOpen, staleTime: 30_000 },
  );

  const createStashMutation = trpc.flows.createStash.useMutation({
    onSuccess: () => {
      void utils.flows.listStashes.invalidate();
    },
  });

  const deleteStashMutation = trpc.flows.deleteStash.useMutation({
    onSuccess: () => {
      void utils.flows.listStashes.invalidate();
    },
  });

  /**
   * Returns true on success (signals StashNamePopover to close + clear input).
   * Returns false on failure (popover stays open so the user can retry).
   */
  const handleStash = async (name: string): Promise<boolean> => {
    try {
      await createStashMutation.mutateAsync({
        name,
        content: briefing,
        sourceFlowId: flowId,
        sourceFlowName: flowName,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save stash');
      return false;
    }
    onSettingsChange(patch(settings, { briefing: undefined }));
    toast.success(`Briefing stashed as "${name}"`);
    onAfterStash?.();
    return true;
  };

  const applyStash = (stash: BriefingStash) => {
    if (isActive) {
      // Confirmation required before overwriting an existing briefing
      setPendingRestore(stash);
      setConfirmRestore(true);
      setRestoreOpen(false);
    } else {
      onSettingsChange(patch(settings, { briefing: stash.content }));
      setRestoreOpen(false);
      toast.success(`Restored "${stash.name}"`);
    }
  };

  const confirmRestoreAction = () => {
    if (!pendingRestore) return;
    onSettingsChange(patch(settings, { briefing: pendingRestore.content }));
    toast.success(`Restored "${pendingRestore.name}"`);
    setPendingRestore(null);
  };

  const handleDelete = (id: string) => {
    deleteStashMutation.mutate(
      { id },
      {
        onSuccess: () => {
          toast.success('Stash deleted');
        },
        onError: (err) => {
          toast.error(err.message || 'Could not delete stash');
        },
      },
    );
  };

  return (
    <>
      <div className="flex items-center gap-1">
        {/* Stash button — only when briefing is active */}
        {isActive && (
          <StashNamePopover disabled={createStashMutation.isPending} onConfirm={handleStash} />
        )}

        {/* Restore dropdown — always visible */}
        <Popover open={restoreOpen} onOpenChange={setRestoreOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              aria-label="Restore a stashed briefing"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Restore
              <ChevronDown className="h-2.5 w-2.5" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1.5" align="end">
            {stashesLoading ? (
              <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">Loading…</p>
            ) : stashes.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                No stashes yet — save a briefing to stash it.
              </p>
            ) : (
              <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
                {stashes.map((s) => (
                  <StashRow key={s.id} stash={s} onRestore={applyStash} onDelete={handleDelete} />
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Confirmation dialog when restoring a stash over an active briefing */}
      <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace current briefing?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace your current briefing with &ldquo;{pendingRestore?.name}&rdquo;. The
              current briefing will be lost unless you stash it first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingRestore(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRestoreAction}>Replace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
