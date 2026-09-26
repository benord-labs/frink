/**
 * FlowEditor three-zone header: breadcrumb + identity/save-status cluster (left),
 * Editor|Runs tabs + actions (right). Presentational — the parent owns all state and
 * mutations (props arrive as per-concern groups). The Editor|Runs toggle is ALWAYS
 * visible: monitoring is a permanent facet of a flow, not a mode that appears once a
 * batch exists.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import {
  Activity,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Radio,
  Save,
  Settings,
  X,
} from 'lucide-react';
import type { ReactElement } from 'react';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { Kbd } from '../../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utils';
import type { BatchRunState } from '../../../../lib/utils/batch-run-state';
import { formatRelativeTime } from '../../../../lib/utils/format-time';
import { FlowLastRunBadge } from '../FlowLastRunBadge';
import { FlowRunButton } from '../FlowRunButton';
import { FlowRunStatusIcon, flowRunDisplayStatus } from '../FlowRunStatusIcon';
import { NodeHealthBadge } from '../NodeHealthBadge';

type FlowEditorTab = 'editor' | 'runs';

/** Canvas execution overlay slice for this flow (see flowCanvasExecutionAtom). */
type CanvasExecStateLike = {
  flowRunId: string;
  isLive?: boolean;
  isHistoricalInspection?: boolean;
};

/** The overlay run's list row — only the fields the status cluster reads. */
type OverlayRunMetaLike = {
  status: string;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case tRPC/DB shape
  active_task_status?: string | null;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case tRPC/DB shape
  started_at: string | null;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case tRPC/DB shape
  completed_at: string | null;
};

/** Save-status cluster inputs. */
type SaveStatusGroup = {
  draftRestored: boolean;
  hasChanges: boolean;
  label: string | null;
  pending: boolean;
  disabled: boolean;
  onSave: () => void;
  onDiscardDraft: () => void;
};

/** Canvas overlay cluster inputs. */
type OverlayGroup = {
  state: CanvasExecStateLike | undefined;
  runMeta: OverlayRunMetaLike | undefined;
  onClear: () => void;
};

/** Run button cluster inputs (targets the batch the user is looking at). */
type RunGroup = {
  state: BatchRunState | null;
  isBatchDeferred: boolean;
  disabled: boolean;
  pending: boolean;
  onPrimaryStart: () => void;
};

type FlowEditorHeaderProps = {
  flowId: string;
  graph: FlowGraph;
  onBack: () => void;
  title: string;
  onTitleChange: (value: string) => void;
  onTitleBlur: () => void;
  versionLabel: string | null;
  save: SaveStatusGroup;
  overlay: OverlayGroup;
  editorTab: FlowEditorTab;
  onEditorTabChange: (tab: FlowEditorTab) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onAddStep: () => void;
  run: RunGroup;
};

/** Finished-run overlay caption ("Viewing run from …" / "Completed · …"). */
function overlayStatusText(
  state: CanvasExecStateLike,
  runMeta: OverlayRunMetaLike | undefined,
): string {
  const shortId = `${state.flowRunId.slice(0, 8)}…`;
  if (state.isHistoricalInspection) {
    return runMeta?.started_at
      ? `Viewing run from ${formatRelativeTime(runMeta.started_at)}`
      : `Viewing run · ${shortId}`;
  }
  if (!runMeta) return `Run on canvas · ${shortId}`;
  const statusLabel =
    { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[runMeta.status] ??
    'Finished';
  const when = runMeta.completed_at ?? runMeta.started_at ?? new Date().toISOString();
  return `${statusLabel} · ${formatRelativeTime(when)}`;
}

/** Live/finished canvas-overlay status cluster (aria-live region). */
function OverlayStatusCluster({ state, runMeta, onClear }: OverlayGroup): ReactElement {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="contents">
      {state?.isLive ? (
        <span className="ml-1.5 flex min-w-0 flex-wrap items-center gap-1 text-[11px] font-medium text-emerald-500">
          <Radio className="h-2.5 w-2.5 shrink-0 animate-pulse" aria-hidden />
          <span className="shrink-0">Live</span>
          {runMeta?.started_at ? (
            <span className="truncate font-normal text-muted-foreground">
              · started {formatRelativeTime(runMeta.started_at)}
            </span>
          ) : null}
        </span>
      ) : null}
      {state && !state.isLive ? (
        <span className="ml-1.5 flex min-w-0 max-w-[min(100%,18rem)] flex-wrap items-center gap-1.5">
          {runMeta ? (
            <FlowRunStatusIcon
              status={flowRunDisplayStatus(runMeta.status, runMeta.active_task_status)}
              size="sm"
              labelled={false}
            />
          ) : null}
          <span className="truncate text-[11px] text-muted-foreground" title={state.flowRunId}>
            {overlayStatusText(state, runMeta)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-1 py-0 flex shrink-0 gap-0.5 text-[11px]"
            title="Clear execution overlay"
            onClick={onClear}
          >
            <X className="h-3 w-3" aria-hidden />
            Clear
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** Save-status line: label, draft-restore announcement + discard control. */
function SaveStatusCluster({ save }: { save: SaveStatusGroup }): ReactElement {
  return (
    <>
      {/* Persistent live region: announces a draft restore to screen readers (WCAG 4.1.3),
          since the visible status label below isn't inside an aria-live container. */}
      <span className="sr-only" role="status" aria-live="polite">
        {save.draftRestored && save.hasChanges ? 'Restored unsaved draft' : ''}
      </span>
      {save.label && (
        <span
          className={cn(
            'text-[11px] ml-1.5 shrink-0',
            save.hasChanges && !save.pending ? 'text-warning' : 'text-muted-foreground/60',
          )}
        >
          {save.label}
        </span>
      )}
      {save.draftRestored && save.hasChanges && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={save.onDiscardDraft}
        >
          Discard draft
        </Button>
      )}
    </>
  );
}

function BackToListButton({
  onBack,
  iconOnly,
}: {
  onBack: () => void;
  iconOnly: boolean;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={iconOnly ? 'h-7 w-7 shrink-0' : 'h-7 px-1.5 text-sm shrink-0'}
          aria-label="Back to flows list"
          onClick={onBack}
          iconOnly={iconOnly}
        >
          {iconOnly ? <X className="h-4 w-4" aria-hidden /> : 'Flows'}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2 text-xs">
        <span>Back to flows list</span>
        <Kbd shortcutId="flow-editor-back-to-list" />
      </TooltipContent>
    </Tooltip>
  );
}

function TabToggle({
  editorTab,
  onEditorTabChange,
}: {
  editorTab: FlowEditorTab;
  onEditorTabChange: (tab: FlowEditorTab) => void;
}): ReactElement {
  const buttonClass = (tab: FlowEditorTab) =>
    cn(
      'rounded',
      tab === 'runs' && 'gap-1',
      editorTab === tab
        ? 'bg-card text-foreground shadow-xs hover:bg-card'
        : 'text-muted-foreground hover:text-foreground',
    );
  return (
    <div className="flex items-center rounded-md bg-muted p-0.5 gap-0">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={buttonClass('editor')}
        onClick={() => onEditorTabChange('editor')}
        aria-pressed={editorTab === 'editor'}
      >
        Editor
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={buttonClass('runs')}
        onClick={() => onEditorTabChange('runs')}
        aria-pressed={editorTab === 'runs'}
      >
        <Activity className="h-3 w-3" aria-hidden />
        Runs
      </Button>
    </div>
  );
}

export function FlowEditorHeader({
  flowId,
  graph,
  onBack,
  title,
  onTitleChange,
  onTitleBlur,
  versionLabel,
  save,
  overlay,
  editorTab,
  onEditorTabChange,
  settingsOpen,
  onToggleSettings,
  onAddStep,
  run,
}: FlowEditorHeaderProps): ReactElement {
  const briefingActive = Boolean(graph.settings?.briefing?.trim());
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border/40 px-3 py-2">
      {/* Left zone: breadcrumb + identity */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <BackToListButton onBack={onBack} iconOnly={false} />
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" aria-hidden />
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <Input
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              onBlur={onTitleBlur}
              size="xs"
              className="font-semibold border-transparent bg-transparent hover:border-border/60 focus:border-border px-1.5 min-w-0"
              aria-label="Flow name"
            />
            {versionLabel && (
              <span className="text-[10px] text-muted-foreground/60 bg-muted/60 rounded px-1 py-0.5 shrink-0 font-mono">
                {versionLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <SaveStatusCluster save={save} />
            <div className="ml-1.5 flex items-center gap-2">
              {!save.hasChanges && !overlay.state ? <FlowLastRunBadge flowId={flowId} /> : null}
              <NodeHealthBadge graph={graph} />
            </div>
            <OverlayStatusCluster {...overlay} />
          </div>
        </div>
      </div>

      {/* Right zone: tabs + actions */}
      <div className="flex items-center gap-1 shrink-0">
        <TabToggle editorTab={editorTab} onEditorTabChange={onEditorTabChange} />
        <div className="w-px h-4 bg-border/60 mx-0.5 shrink-0" aria-hidden />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`h-7 gap-1 text-xs ${settingsOpen ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground'}`}
          title={briefingActive ? 'Flow settings (briefing active)' : 'Flow settings'}
          aria-pressed={settingsOpen}
          onClick={onToggleSettings}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
          Settings
          {briefingActive && (
            <FileText className="h-3 w-3 text-primary" aria-label="Briefing active" />
          )}
        </Button>

        {editorTab === 'editor' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            title="Add step (N)"
            onClick={onAddStep}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add step
          </Button>
        )}

        <div className="w-px h-4 bg-border/60 mx-0.5 shrink-0" aria-hidden />

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5 text-xs relative"
          disabled={save.disabled}
          title="Save (⌘S)"
          onClick={save.onSave}
        >
          {save.pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden />
          )}
          Save
          {save.hasChanges && !save.pending && (
            <span
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400"
              aria-hidden
            />
          )}
        </Button>

        <FlowRunButton
          runState={run.state}
          isBatchDeferred={run.isBatchDeferred}
          disabled={run.disabled}
          isPending={run.pending}
          onPrimaryStart={run.onPrimaryStart}
        />

        <div className="w-px h-4 bg-border/60 mx-0.5 shrink-0" aria-hidden />
        <BackToListButton onBack={onBack} iconOnly={true} />
      </div>
    </header>
  );
}
