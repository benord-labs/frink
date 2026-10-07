/**
 * FlowRunStrip — the flow chat's bottom surface while a run actively drives the sub-chat
 * (decision flow-run-chat-surface). Two variants replace the composer:
 *
 * - `FlowRunStrip` (the run is working): current node name + collapsed "Add a note" (rides the
 *   normal send pipe, which QUEUES while the agent streams) + Pause (only when a running task makes
 *   it real) + Stop.
 * - `FlowPausedBar` (user-pause park): reply box (same follow-up-resume pipe) + Resume + Stop.
 *
 * Pause = flows.pauseRun (park-first + abort-without-reconcile in the main process). Both
 * destructive verbs sit behind a two-step inline confirm (see StopRunButton).
 *
 * Both variants lay out as ONE `FlowSurfaceCard`, which stacks quiet context (the readout chips)
 * over the live line (status sentence + controls) over the input. That borrows RunStatusRow's
 * GRAMMAR — muted readout, actions right, terminal action rightmost — without borrowing the
 * component, whose responsive `justify-between`/`flex-col` would MOVE Stop whenever Pause unmounts
 * mid-run, and whose transparent row cannot absorb StatusAndQueueSection's -mb-6 overlap.
 *
 * WHERE A CONTROL LIVES IS A CONTRACT, and it is the thing to preserve when editing this file. The
 * pinned group holds only controls that are stable for the life of the run, because its last child
 * is Stop and a group that changes width drags Stop under a cursor mid-click. Anything that comes
 * and goes belongs in the card's `aside` slot, which sits BEFORE that group so its removal only
 * widens the status sentence beside it.
 *
 * The note toggle is the case that proves it. It unmounts while its field is open, because once the
 * field is there the verb it offers is already carried out; keeping it would leave a control
 * restating a done action above the note being typed. That is only safe from `aside` — from inside
 * the pinned group the same unmount would move Stop, which is what forced an earlier version to
 * keep it mounted as a de-labelled glyph instead.
 */
import { Button } from '@benord-labs/frink-primitives';
import { Loader2, Pause, Pencil, Play } from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import type { ChatMode } from '../../../../../../../shared/types/chat-mode';
import type { CodexSpeed } from '../../../../../../../shared/types/execution';
import { useFlowNoteField } from '../../../../../../lib/agent-chat/use-flow-note-field';
import { useFlowResumeLock } from '../../../../../../lib/agent-chat/use-flow-resume-lock';
import { trpc } from '../../../../../../lib/trpc';
import { agentChatStore } from '../../../../stores/agent-chat-store';
import { invalidateTaskQueries } from '../../utils';
import { FlowReplyBox } from '../FlowReplyBox';
import { FlowRunMeta } from './FlowRunMeta';
import { FlowSurfaceCard, StripAction } from './FlowSurfaceCard';
import { StopRunButton } from './StopRunButton';

type FlowRunStripProps = {
  subChatId: string;
  flowRunId: string;
  /** False wherever parkFlowTaskForSubChat would refuse — a batch member, or no running task to
   * park (the taskless windows) — so Pause is pre-hidden rather than offered as a no-op. */
  canPause: boolean;
  /** The running node's model picker id + mode — a read-only readout of what the composer showed. */
  modelId?: string;
  mode?: ChatMode;
  /** The flow's Auto Mode consent, snapshotted onto the task at dispatch. */
  autoReviewTools?: boolean;
  codexSpeed?: CodexSpeed;
  /** Sends a note through the normal send pipe (queues while streaming); returns whether sent. */
  onAddNote: (text: string) => boolean;
  /** Aborts the local in-flight turn (composer stop) — combined with flows.cancelRun for Stop. */
  onStopTurn: () => Promise<void> | void;
};

/**
 * The running strip's status half: the spinner and ONE sentence, nothing else. The card owns its
 * type and colour now that the sentence has a line to itself, so this passes a bare span and lets
 * the inner label carry the ellipsis.
 *
 * It does NOT step aside while Stop is armed. That shed existed only because the sentence used to
 * share a row with the confirm pair; on its own line it never competes with them, and the node name
 * is the most load-bearing fact on screen at the moment you are deciding whether to kill the run.
 */
function RunStatus({ label }: { label: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" aria-live="polite">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      <span className="truncate" title={label}>
        {label}
      </span>
    </span>
  );
}

/**
 * The note toggle. It sits in the card's `aside` slot, NOT in the pinned action group, and that
 * placement is the whole reason it can behave sanely: removing it only widens the status sentence
 * beside it, so Stop's right edge does not move. Being free to unmount is what lets it simply
 * disappear while its field is open, instead of lingering as a de-labelled glyph restating a verb
 * you have already carried out. Focus is handed back when it returns (see useFlowNoteField).
 *
 * The two ways of getting out of the way are NOT interchangeable. Unmounting is for "the field is
 * open", where the toggle has nothing left to offer. `offscreen` is for "Stop is armed", where the
 * row needs the width but the field may still close at any moment and hand focus back here; an
 * unmounted button cannot receive that focus, an `sr-only` one can.
 */
function NoteToggle({
  note,
  offscreen,
}: {
  note: ReturnType<typeof useFlowNoteField>;
  offscreen: boolean;
}) {
  return (
    <StripAction
      offscreen={offscreen}
      buttonRef={note.toggleRef}
      label="Add a note"
      title="Steer the running step"
      icon={<Pencil className="h-3 w-3" aria-hidden />}
      onClick={note.expand}
      aria-expanded={false}
      aria-controls={note.fieldId}
    />
  );
}

/**
 * The run controls, and ONLY the run controls. Pause steps aside while Stop is armed so the two
 * confirm verbs keep their full wording at every width: a destructive confirm must never reduce to a
 * glyph, and an X beside "Confirm stop" would read as "cancel the run".
 */
function RunActions({
  confirming,
  canPause,
  pausePending,
  onPause,
  children,
}: {
  confirming: boolean;
  canPause: boolean;
  pausePending: boolean;
  onPause: () => void;
  /** The terminal action, kept last by the caller. */
  children: ReactNode;
}) {
  return (
    <>
      {canPause && !confirming ? (
        <StripAction
          label="Pause"
          title="Stop the current step now — the run stays resumable."
          variant="secondary"
          icon={
            pausePending ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <Pause className="h-3 w-3" aria-hidden />
            )
          }
          disabled={pausePending}
          onClick={onPause}
        />
      ) : null}
      {children}
    </>
  );
}

export const FlowRunStrip = memo(function FlowRunStrip({
  subChatId,
  flowRunId,
  canPause,
  modelId,
  mode,
  autoReviewTools,
  codexSpeed,
  onAddNote,
  onStopTurn,
}: FlowRunStripProps) {
  const utils = trpc.useUtils();
  // Current node label for the status line. Light poll while the strip is visible. The strip tracks
  // the RUN, not a task: it also renders across the taskless windows (between two agent nodes, while
  // a non-agent node runs), where no node_run is `running` yet and the label falls back to generic.
  const { data: run } = trpc.flows.getRun.useQuery({ runId: flowRunId }, { refetchInterval: 5000 });
  const runningNodeRun = run?.nodeRuns?.find((nr) => nr.status === 'running');
  const graphNode = run?.graph?.nodes?.find((n) => n.id === runningNodeRun?.node_id);
  const nodeLabel = graphNode?.label ?? graphNode?.blockType ?? null;
  const [confirming, setConfirming] = useState(false);

  const pauseRun = trpc.flows.pauseRun.useMutation({
    onSuccess: (data) => {
      if (!data.paused) {
        toast.info('Nothing to pause — the step may have just finished');
      }
      invalidateTaskQueries(utils);
      utils.flows.getRun.invalidate();
      utils.flows.listRuns.invalidate();
    },
    onError: (e) => toast.error(e.message || 'Could not pause the run'),
  });

  // Open/closed + draft policy lives in the hook (see useFlowNoteField for why it reopens on mount
  // and why ✕ and Escape differ).
  const note = useFlowNoteField(flowRunId, subChatId);
  const label = nodeLabel ? `Running ${nodeLabel}` : 'Flow running…';

  return (
    <FlowSurfaceCard
      status={<RunStatus label={label} />}
      meta={
        <FlowRunMeta
          modelId={modelId}
          mode={mode}
          autoReviewTools={autoReviewTools}
          codexSpeed={codexSpeed}
          confirming={confirming}
        />
      }
      // MOUNTING is gated on `note.open` and nothing else, deliberately: useFlowNoteField hands
      // focus back to this toggle when the field closes and its effect keys on exactly that flag, so
      // a second unmount gate would let the field close while the toggle is absent, dropping the
      // focus restore with no way to recover it.
      //
      // Arming Stop therefore hides it with `sr-only` instead of removing it. That still frees the
      // row (an sr-only element is absolutely positioned, so it is out of flow) while leaving the
      // button focusable, which is the one thing unmounting could not do. Without it the armed row
      // is the confirm pair plus a glyph and spills out of a pane under 320px.
      aside={note.open ? null : <NoteToggle note={note} offscreen={confirming} />}
      actions={
        <RunActions
          confirming={confirming}
          canPause={canPause}
          pausePending={pauseRun.isPending}
          onPause={() => pauseRun.mutate({ subChatId })}
        >
          <StopRunButton
            flowRunId={flowRunId}
            onStopTurn={onStopTurn}
            onConfirmingChange={setConfirming}
          />
        </RunActions>
      }
    >
      {note.open ? (
        <div id={note.fieldId}>
          <FlowReplyBox
            bare
            autoFocus
            submit="steer"
            value={note.note}
            onChange={note.setNote}
            // ✕ discards; Escape only collapses (it is pressed reflexively to shed focus, and the
            // draft is a paragraph the atom is there to protect). The text stays one click away —
            // reopening the field shows it.
            onCancel={(reason) => note.collapse(reason === 'button')}
            // "Steer", matching what the control now does: the note reaches the RUNNING step rather
            // than waiting for it. This is the only cue a sighted mouse user gets (the button's
            // label is aria/tooltip-only). Short enough not to truncate, and it promises the next
            // step rather than immediacy — a long tool call defers pickup.
            placeholder="Steer the running step…"
            ariaLabel="Message the agent"
            onSubmit={(text) => {
              // Keep the text on a failed send so the user can retry.
              if (!onAddNote(text)) return false;
              note.collapse(false); // submitted, not dismissed — FlowReplyBox clears the draft
              return true;
            }}
          />
        </div>
      ) : null}
    </FlowSurfaceCard>
  );
});

type FlowPausedBarProps = {
  flowRunId: string;
  subChatId: string;
  /** The paused node's model picker id + mode — the same read-only readout as the running strip. */
  modelId?: string;
  mode?: ChatMode;
  autoReviewTools?: boolean;
  codexSpeed?: CodexSpeed;
  /** True after the accepted continuation enters submitted/streaming state. */
  isTurnActive: boolean;
  /** Sends the reply as a follow-up message (resumes the flow in place); returns whether sent. */
  onSubmitAnswer: (text: string) => boolean;
  /** Resume without new instructions — a hidden wake message through the same pipe. */
  onResume: () => boolean;
  onStopTurn: () => Promise<void> | void;
};

export const FlowPausedBar = memo(function FlowPausedBar({
  flowRunId,
  subChatId,
  modelId,
  mode,
  autoReviewTools,
  codexSpeed,
  isTurnActive,
  onSubmitAnswer,
  onResume,
  onStopTurn,
}: FlowPausedBarProps) {
  const [confirming, setConfirming] = useState(false);
  // Single-shot lock shared by Resume and a typed Reply — see useFlowResumeLock for why release is
  // engine-confirmed rather than optimistic.
  const {
    resumePending,
    start: startResume,
    markStopRequested,
  } = useFlowResumeLock(flowRunId, () => agentChatStore.get(subChatId), isTurnActive);

  return (
    <FlowSurfaceCard
      // The sentence keeps its words while Stop is armed: on its own line it never shares width
      // with the confirm pair, so the shed that used to blank it is gone.
      status={
        <span className="min-w-0 flex-1 truncate">
          Flow paused, reply with new instructions, or press Resume to continue.
        </span>
      }
      meta={
        <FlowRunMeta
          modelId={modelId}
          mode={mode}
          autoReviewTools={autoReviewTools}
          codexSpeed={codexSpeed}
          confirming={confirming}
        />
      }
      actions={
        <>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 shrink-0 gap-1 text-xs"
            disabled={resumePending}
            onClick={() => startResume(onResume)}
            aria-busy={resumePending || undefined}
          >
            {resumePending ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <Play className="h-3 w-3" aria-hidden />
            )}
            {/* Never sheds to a glyph: this span IS the resume-in-progress announcement. */}
            <span aria-live="polite">{resumePending ? 'Resuming…' : 'Resume'}</span>
          </Button>
          <StopRunButton
            flowRunId={flowRunId}
            onConfirmingChange={setConfirming}
            onStopTurn={() => {
              markStopRequested();
              return onStopTurn();
            }}
          />
        </>
      }
    >
      <FlowReplyBox
        bare
        disabled={resumePending}
        placeholder="Reply with new instructions…"
        onSubmit={(text) => startResume(() => onSubmitAnswer(text))}
      />
    </FlowSurfaceCard>
  );
});
