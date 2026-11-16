/** Flow Settings → Priority queue: off, every new run, or only runs whose details match a rule. */

import type { ReactElement } from 'react';
import { z } from 'zod';
import {
  type PriorityQueueMode,
  priorityQueueMode,
  readyRunFirstRule,
} from '../../../../../../shared/lib/flow-admission/run-first-rule';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import type { FlowSettings } from '../../../../../../shared/types/flow';
import {
  RUN_FIRST_RULE_MAX_ROWS,
  type RunFirstRow,
  runFirstOperatorSchema,
} from '../../../../../../shared/types/flow-settings-schema';
import { Label } from '../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { runFirstDetails } from '../../../../../lib/flows/admission/run-first-details';
import type { ConditionFilter } from '../../../../../lib/flows/webhook-trigger/types';
import { trpc } from '../../../../../lib/trpc';
import { ConditionFiltersSection } from '../../BlockConfig/WebhookTriggerConfig/ConditionFiltersSection';
import { patch } from '../patch';

type Props = {
  settings: FlowSettings | undefined;
  nodes: readonly FlowNode[];
  triggerBlockType: string | undefined;
  onSettingsChange: (settings: FlowSettings) => void;
};

const BLANK_ROW: RunFirstRow = { detail: '', operator: 'contains', value: '' };

const MODES: ReadonlyArray<{ value: PriorityQueueMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'every', label: 'Every new run' },
  { value: 'match', label: 'Only runs that match' },
];

const HINTS = {
  off: 'New runs of this flow wait in the normal queue.',
  every:
    'New runs of this flow join the priority queue and start before other waiting runs. Runs already waiting keep their place, and nothing running is stopped.',
  match:
    'Runs whose details match every row join the priority queue and start before other waiting runs.',
};

const NOT_READY =
  "This rule isn't active yet: give every row a detail and a value. Until then, runs keep their normal place.";
const NO_DETAILS = 'Every run of this flow looks the same, so choose Every new run or Off.';

function modeSettings(mode: string): Partial<FlowSettings> {
  if (mode === 'every') return { runFirst: true, runFirstWhen: undefined };
  if (mode === 'match') return { runFirst: undefined, runFirstWhen: [BLANK_ROW] };
  return { runFirst: undefined, runFirstWhen: undefined };
}

function hintFor(
  mode: PriorityQueueMode,
  rows: readonly RunFirstRow[],
  noDetails: boolean,
): string {
  if (noDetails && mode !== 'every') return NO_DETAILS;
  if (mode === 'match' && !readyRunFirstRule(rows)) return NOT_READY;
  return HINTS[mode];
}

/** A row edit as stored, capped at what settings accept so one long paste never blocks a save. */
function editedRow(row: RunFirstRow, updates: Partial<ConditionFilter>): RunFirstRow {
  const operator = runFirstOperatorSchema.safeParse(updates.operator).data ?? row.operator;
  const detail = updates.field ?? row.detail;
  const value = z.string().safeParse(updates.value).data ?? row.value;
  return { detail: detail.slice(0, 200), operator, value: value.slice(0, 500) };
}

function useRunFirstDetails(
  nodes: readonly FlowNode[],
  triggerBlockType: string | undefined,
  settings: FlowSettings | undefined,
) {
  const config = nodes.find((node) => node.blockType === triggerBlockType)?.config;
  const { data: integrations } = trpc.integrations.list.useQuery();
  const provider = integrations?.find((i) => i.id === config?.integrationId)?.provider;
  return runFirstDetails({
    triggerBlockType,
    provider,
    eventType: z.string().safeParse(config?.eventType).data,
    batchKeys: settings?.batchTriggerSchema?.map((item) => item.key),
  });
}

export function PriorityQueueSetting({
  settings,
  nodes,
  triggerBlockType,
  onSettingsChange,
}: Props): ReactElement {
  const { suggestions, noDetails } = useRunFirstDetails(nodes, triggerBlockType, settings);
  const mode = priorityQueueMode(settings);
  const rows = settings?.runFirstWhen ?? [];
  const saveRows = (next: RunFirstRow[]) =>
    onSettingsChange(patch(settings, { runFirstWhen: next.length > 0 ? next : undefined }));

  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <Label htmlFor="flow-settings-run-first" className="text-xs font-medium">
          Priority queue
        </Label>
        <p className="text-sm text-muted-foreground">{hintFor(mode, rows, noDetails)}</p>
      </div>
      <Select
        value={mode}
        onValueChange={(next) => onSettingsChange(patch(settings, modeSettings(next)))}
      >
        <SelectTrigger id="flow-settings-run-first">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODES.map((m) => (
            <SelectItem key={m.value} value={m.value} disabled={m.value === 'match' && noDetails}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === 'match' ? (
        <ConditionFiltersSection
          filters={rows.map((row, i) => ({
            id: String(i),
            field: row.detail,
            operator: row.operator,
            value: row.value,
          }))}
          availableFilterFields={[]}
          fieldSuggestions={suggestions}
          addLabel="Add row"
          onAddFilter={
            rows.length < RUN_FIRST_RULE_MAX_ROWS ? () => saveRows([...rows, BLANK_ROW]) : undefined
          }
          onUpdateFilter={(id, updates) =>
            saveRows(rows.map((row, i) => (String(i) === id ? editedRow(row, updates) : row)))
          }
          onRemoveFilter={(id) => saveRows(rows.filter((_, i) => String(i) !== id))}
        />
      ) : null}
    </div>
  );
}
