/**
 * Schedule trigger: cron config stored on the flow graph node.
 */

import { Input } from '@benord-labs/frink-primitives';
import { Cron } from 'croner';
import { type ReactElement, useMemo } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import { Checkbox } from '../../../../../components/ui/checkbox';
import { Label } from '../../../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { FieldRow } from '../shared';

const COMMON_TZS = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
];

function readStr(cfg: Record<string, unknown> | undefined, key: string, fallback: string): string {
  const v = cfg?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

type Props = {
  node: FlowNode;
  onPatchLabel: (patch: { label?: string }) => void;
  onPatchConfig: (config: Record<string, unknown>) => void;
};

export function ScheduleTriggerConfig({
  node,
  onPatchLabel,
  onPatchConfig,
}: Props): ReactElement {
  const cfg = node.config;
  const cronExpression = readStr(cfg, 'cronExpression', '0 * * * *');
  const timezone = readStr(cfg, 'timezone', 'UTC');
  const description = readStr(cfg, 'description', '');
  const skipIfRunning = cfg?.skipIfRunning === true;

  const preview = useMemo(() => {
    try {
      const c = new Cron(cronExpression, { timezone });
      return c.nextRuns(5).map((d, i) => ({
        iso: d.toISOString(),
        // Position disambiguates duplicate ISO strings; avoid using map index as key in JSX (biome).
        key: `${d.toISOString()}#${i}`,
      }));
    } catch {
      return [] as Array<{ iso: string; key: string }>;
    }
  }, [cronExpression, timezone]);

  const patchSchedule = (partial: Record<string, unknown>): void => {
    onPatchConfig({
      cronExpression,
      timezone,
      description,
      skipIfRunning,
      ...partial,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldRow htmlFor="flow-schedule-label" label="Display name" hint="Shown in the step list.">
        <Input
          id="flow-schedule-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Schedule trigger"
        />
      </FieldRow>

      <FieldRow
        htmlFor="flow-schedule-cron"
        label="Cron expression"
        hint="Minute hour day month weekday (e.g. 0 * * * * = hourly on the hour)."
      >
        <Input
          id="flow-schedule-cron"
          value={cronExpression}
          onChange={(e) => patchSchedule({ cronExpression: e.target.value })}
        />
      </FieldRow>

      <FieldRow htmlFor="flow-schedule-tz" label="Timezone">
        <Select
          value={COMMON_TZS.includes(timezone) ? timezone : '__custom__'}
          onValueChange={(v) => {
            if (v !== '__custom__') patchSchedule({ timezone: v });
          }}
        >
          <SelectTrigger id="flow-schedule-tz">
            <SelectValue placeholder="Timezone" />
          </SelectTrigger>
          <SelectContent>
            {COMMON_TZS.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
            <SelectItem value="__custom__">Custom…</SelectItem>
          </SelectContent>
        </Select>
        {!COMMON_TZS.includes(timezone) ? (
          <Input
            className="mt-2"
            aria-label="Custom IANA timezone"
            value={timezone}
            onChange={(e) => patchSchedule({ timezone: e.target.value })}
            placeholder="e.g. Australia/Sydney"
          />
        ) : null}
      </FieldRow>

      <FieldRow htmlFor="flow-schedule-desc" label="Description (optional)">
        <Input
          id="flow-schedule-desc"
          value={description}
          onChange={(e) => patchSchedule({ description: e.target.value })}
          placeholder="Nightly health check"
        />
      </FieldRow>

      <div className="flex items-center gap-2 text-sm">
        <Checkbox
          id="flow-schedule-skip-running"
          checked={skipIfRunning}
          onCheckedChange={(v) => patchSchedule({ skipIfRunning: v === true })}
        />
        <Label htmlFor="flow-schedule-skip-running" className="font-normal cursor-pointer">
          Skip if a run of this flow is already active
        </Label>
      </div>

      {preview.length > 0 ? (
        <div className="text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Next runs (approx.)</p>
          <ul className="list-disc pl-4">
            {preview.map(({ iso, key }) => (
              <li key={key}>{iso}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-destructive">
          Invalid cron or timezone — fix expression to preview.
        </p>
      )}

    </div>
  );
}
