/**
 * Batch Trigger Variables section for FlowSettingsPanel.
 *
 * Only rendered when the flow uses `manual_trigger` (the only trigger type that
 * supports arbitrary CEO-injected trigger_context keys via frink_flows_define_stages).
 *
 * Two sub-sections:
 * - Declared variables: editable list from graph.settings.batchTriggerSchema.
 *   Declaring a variable upgrades it from the generic "any key" note to a typed
 *   chip in the Available Variables panel for all blocks in the flow.
 * - From runs: read-only union of trigger_context keys detected from the first
 *   page of batch stage runs. Shows what the CEO agent actually injected.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { Plus, Trash2, Variable } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import type { BatchTriggerSchemaItem } from '../../../../../../shared/types/flow-settings-schema';
import { Label } from '../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';

/**
 * Static keys from the manual_trigger schema — already have green chips in the editor.
 * Variables matching these keys are never shown with an amber "not declared" badge.
 */
const STATIC_TRIGGER_KEYS = new Set([
  'label',
  'customInstructions',
  'attachments',
  'baseBranch',
  'baseBranches',
  'mergeStrategy',
]);

const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;
const KEY_PATTERN = /^[a-zA-Z_]\w*$/;
const MAX_ENTRIES = 100;

type Props = {
  flowId: string;
  batchId: string | null | undefined;
  schema: BatchTriggerSchemaItem[] | undefined;
  onChange: (schema: BatchTriggerSchemaItem[] | undefined) => void;
};

export function BatchTriggerVariables({ flowId, batchId, schema, onChange }: Props): ReactElement {
  const declared = schema ?? [];

  return (
    <div
      className={cn(
        'grid gap-3 rounded-xl border border-border/40 p-3',
        'bg-muted/25 dark:bg-muted/15',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Variable className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <Label className="text-xs font-medium">Batch trigger variables</Label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Declare the <code className="font-mono">{'{{trigger.*}}'}</code> variables your batch flow
        expects. Declarations only drive editor chips and validation — values at runtime come from
        each run&apos;s <code className="font-mono">triggerContext</code> in{' '}
        <code className="font-mono">frink_flows_define_stages</code> /{' '}
        <code className="font-mono">frink_flows_add_stage_runs</code>. From runs lists keys seen on
        stored runs (may differ per run).
      </p>

      <DeclaredVariables declared={declared} onChange={onChange} />

      {batchId && (
        <FromRunsSection
          flowId={flowId}
          batchId={batchId}
          declaredKeys={declared.map((d) => d.key)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Declared variables (editable)
// ---------------------------------------------------------------------------

type DeclaredVariablesProps = {
  declared: BatchTriggerSchemaItem[];
  onChange: (schema: BatchTriggerSchemaItem[] | undefined) => void;
};

function DeclaredVariables({ declared, onChange }: DeclaredVariablesProps): ReactElement {
  const [newKey, setNewKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);

  const existingKeys = useMemo(() => new Set(declared.map((d) => d.key)), [declared]);

  const handleAdd = () => {
    const key = newKey.trim();
    if (!key) return;
    if (!KEY_PATTERN.test(key)) {
      setKeyError(
        'Must be a valid identifier (letters, digits, underscore; start with letter or _)',
      );
      return;
    }
    if (existingKeys.has(key)) {
      setKeyError('Key already declared');
      return;
    }
    if (declared.length >= MAX_ENTRIES) {
      setKeyError(`Maximum ${MAX_ENTRIES} variables allowed`);
      return;
    }
    setKeyError(null);
    setNewKey('');
    onChange([...declared, { key, type: 'string' }]);
  };

  const handleRemove = (key: string) => {
    const next = declared.filter((d) => d.key !== key);
    onChange(next.length === 0 ? undefined : next);
  };

  const handleTypeChange = (key: string, type: BatchTriggerSchemaItem['type']) => {
    onChange(declared.map((d) => (d.key === key ? { ...d, type } : d)));
  };

  const handleDescriptionChange = (key: string, description: string) => {
    onChange(
      declared.map((d) => (d.key === key ? { ...d, description: description || undefined } : d)),
    );
  };

  return (
    <div className="grid gap-2">
      <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
        Declared
      </p>

      {declared.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">
          No variables declared. Add one below.
        </p>
      ) : (
        <ul className="grid gap-2" aria-label="Declared batch trigger variables">
          {declared.map((item) => (
            <DeclaredRow
              key={item.key}
              item={item}
              onRemove={() => handleRemove(item.key)}
              onTypeChange={(type) => handleTypeChange(item.key, type)}
              onDescriptionChange={(desc) => handleDescriptionChange(item.key, desc)}
            />
          ))}
        </ul>
      )}

      <div className="flex gap-1.5 items-start">
        <div className="flex-1 grid gap-0.5">
          <Input
            value={newKey}
            onChange={(e) => {
              setNewKey(e.target.value);
              if (keyError) setKeyError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="variableName"
            size="xs"
            className="text-xs font-mono"
            error={!!keyError}
            maxLength={64}
            aria-label="New variable key"
            aria-describedby={keyError ? 'batch-var-key-error' : undefined}
          />
          {keyError && (
            <p id="batch-var-key-error" className="text-[11px] text-destructive">
              {keyError}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 gap-1 text-xs shrink-0"
          onClick={handleAdd}
          disabled={!newKey.trim()}
          aria-label="Add variable"
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add
        </Button>
      </div>
    </div>
  );
}

type DeclaredRowProps = {
  item: BatchTriggerSchemaItem;
  onRemove: () => void;
  onTypeChange: (type: BatchTriggerSchemaItem['type']) => void;
  onDescriptionChange: (desc: string) => void;
};

function DeclaredRow({
  item,
  onRemove,
  onTypeChange,
  onDescriptionChange,
}: DeclaredRowProps): ReactElement {
  return (
    <li className="grid gap-1 rounded border border-border/60 bg-muted/30 p-2">
      <div className="flex items-center gap-1.5">
        <code className="flex-1 text-xs font-mono text-foreground truncate">
          {'{{trigger.'}
          {item.key}
          {'}}'}
        </code>
        <Select
          value={item.type}
          onValueChange={(v) => onTypeChange(v as BatchTriggerSchemaItem['type'])}
        >
          <SelectTrigger className="h-6 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${item.key}`}
          iconOnly
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </Button>
      </div>
      <Input
        value={item.description ?? ''}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder="Description (optional)"
        className="h-6 text-[11px] border-0 bg-transparent p-0 text-muted-foreground placeholder:text-muted-foreground/50 focus:ring-0"
        maxLength={200}
        aria-label={`Description for ${item.key}`}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// From runs (read-only)
// ---------------------------------------------------------------------------

/**
 * Format a trigger_context value for display in the "e.g." column.
 * Objects and arrays use JSON.stringify (capped at 80 chars) instead of String()
 * which would produce the useless "[object Object]" output.
 */
function formatExampleValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    try {
      const json = JSON.stringify(v);
      return json.length > 80 ? `${json.slice(0, 77)}…` : json;
    } catch {
      return null;
    }
  }
  return String(v);
}

type FromRunsSectionProps = {
  flowId: string;
  batchId: string;
  declaredKeys: string[];
};

function FromRunsSection({ flowId, batchId, declaredKeys }: FromRunsSectionProps): ReactElement {
  const {
    data: stagesData,
    isLoading: isStagesLoading,
    isError: isStagesError,
  } = trpc.flows.listBatchStages.useQuery({ flowId, batchId }, { staleTime: 60_000 });

  const firstStageId = stagesData?.stages?.[0]?.id;

  const {
    data: runsData,
    isLoading: isRunsLoading,
    isError: isRunsError,
  } = trpc.flows.listBatchStageRuns.useQuery(
    { flowId, stageId: firstStageId ?? '', limit: 20 },
    { enabled: !!firstStageId, staleTime: 60_000 },
  );

  const isLoading = isStagesLoading || (!!firstStageId && isRunsLoading);
  const isError = isStagesError || isRunsError;

  const detectedKeys = useMemo((): { key: string; example: string | null }[] => {
    if (!runsData?.runs?.length) return [];
    const keyMap = new Map<string, string | null>();
    for (const run of runsData.runs) {
      const ctx = run.trigger_context;
      if (!ctx || typeof ctx !== 'object') continue;
      for (const [k, v] of Object.entries(ctx as Record<string, unknown>)) {
        if (!keyMap.has(k)) {
          keyMap.set(k, formatExampleValue(v));
        }
      }
    }
    return Array.from(keyMap.entries()).map(([key, example]) => ({ key, example }));
  }, [runsData?.runs]);

  // A key is "resolved" if it is declared in batchTriggerSchema OR is already a static trigger
  // chip — either way no amber "not declared" badge is needed.
  const resolvedSet = useMemo(
    () => new Set([...declaredKeys, ...STATIC_TRIGGER_KEYS]),
    [declaredKeys],
  );

  return (
    <div className="grid gap-2 border-t border-border/40 pt-3">
      <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
        From runs
      </p>
      {isError ? (
        <p className="text-[11px] text-destructive italic">Could not load run data.</p>
      ) : isLoading ? (
        <p className="text-[11px] text-muted-foreground italic">Loading…</p>
      ) : detectedKeys.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">
          No runs yet — detected variables will appear here once the batch starts.
        </p>
      ) : (
        <ul className="grid gap-1" aria-label="Detected trigger variables from runs">
          {detectedKeys.map(({ key, example }) => (
            <li key={key} className="flex items-baseline gap-2 py-0.5">
              <code
                className={cn(
                  'text-[11px] font-mono shrink-0',
                  resolvedSet.has(key) ? 'text-muted-foreground' : 'text-warning',
                )}
                title={
                  resolvedSet.has(key)
                    ? 'Declared'
                    : 'Detected in runs but not declared — will be auto-declared on next batch'
                }
              >
                {'{{trigger.'}
                {key}
                {'}}'}
              </code>
              {example !== null && (
                <span className="text-[10px] text-muted-foreground/70 truncate max-w-[140px]">
                  e.g. {example}
                </span>
              )}
              {!resolvedSet.has(key) && (
                <span className="text-[10px] text-warning shrink-0">not declared</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
