/**
 * Fan Out block configuration.
 * Iterates over an array field from the previous node's output, running the next block once per item.
 */

import { Input } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { cfg, FieldRow } from '../shared';

const FAN_OUT_MAX_ITERATIONS_DEFAULT = 50;
const FAN_OUT_MAX_ITERATIONS_LIMIT = 50;
const FAN_OUT_MAX_PARALLEL_DEFAULT = 5;
const FAN_OUT_MAX_PARALLEL_LIMIT = 10;

type Props = {
  node: FlowNode;
  onPatchLabel: (patch: { label?: string }) => void;
  onConfigPatch: (config: Record<string, unknown>) => void;
};

function clampMaxIterations(n: number): number {
  return Math.min(
    FAN_OUT_MAX_ITERATIONS_LIMIT,
    Math.max(1, Math.floor(Number.isFinite(n) ? n : FAN_OUT_MAX_ITERATIONS_DEFAULT)),
  );
}

function clampMaxParallel(n: number): number {
  return Math.min(
    FAN_OUT_MAX_PARALLEL_LIMIT,
    Math.max(1, Math.floor(Number.isFinite(n) ? n : FAN_OUT_MAX_PARALLEL_DEFAULT)),
  );
}

export function FanOutConfig({ node, onPatchLabel, onConfigPatch }: Props): ReactElement {
  const c = cfg(node);
  const arrayField = typeof c.arrayField === 'string' ? c.arrayField : '';
  const maxIterationsRaw = c.maxIterations;
  const maxIterations =
    typeof maxIterationsRaw === 'number' && maxIterationsRaw > 0
      ? clampMaxIterations(maxIterationsRaw)
      : FAN_OUT_MAX_ITERATIONS_DEFAULT;
  const mode = c.mode === 'parallel' ? 'parallel' : 'sequential';
  const maxParallelRaw = c.maxParallel;
  const maxParallel =
    typeof maxParallelRaw === 'number' && maxParallelRaw > 0
      ? clampMaxParallel(maxParallelRaw)
      : FAN_OUT_MAX_PARALLEL_DEFAULT;

  return (
    <div className="space-y-4">
      <FieldRow htmlFor="flow-fan-out-label" label="Display name" hint="Shown in the step list.">
        <Input
          id="flow-fan-out-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Fan out"
        />
      </FieldRow>
      <FieldRow
        htmlFor="fan-out-array-field"
        label="Array field"
        hint="Name of the array on the previous block's outputs (default in the engine is items if unset)."
      >
        <Input
          id="fan-out-array-field"
          value={arrayField}
          onChange={(e) => onConfigPatch({ arrayField: e.target.value })}
          placeholder="items"
        />
      </FieldRow>
      <FieldRow htmlFor="fan-out-mode" label="Execution mode">
        <Select value={mode} onValueChange={(v) => onConfigPatch({ mode: v })}>
          <SelectTrigger id="fan-out-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sequential">Sequential</SelectItem>
            <SelectItem value="parallel">Parallel</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      {mode === 'parallel' && (
        <FieldRow
          htmlFor="fan-out-max-parallel"
          label="Max parallel lanes"
          hint={`Maximum concurrent lanes (1–${FAN_OUT_MAX_PARALLEL_LIMIT}). Default: ${FAN_OUT_MAX_PARALLEL_DEFAULT}.`}
        >
          <Input
            id="fan-out-max-parallel"
            type="number"
            min={1}
            max={FAN_OUT_MAX_PARALLEL_LIMIT}
            value={maxParallel}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              if (!Number.isNaN(parsed)) {
                onConfigPatch({ maxParallel: clampMaxParallel(parsed) });
              }
            }}
          />
        </FieldRow>
      )}
      <FieldRow
        htmlFor="fan-out-max-iterations"
        label="Max iterations"
        hint={`Safety limit — arrays are truncated to this count (1–${FAN_OUT_MAX_ITERATIONS_LIMIT}).`}
      >
        <Input
          id="fan-out-max-iterations"
          type="number"
          min={1}
          max={FAN_OUT_MAX_ITERATIONS_LIMIT}
          value={maxIterations}
          onChange={(e) => {
            const parsed = Number.parseInt(e.target.value, 10);
            if (!Number.isNaN(parsed)) {
              onConfigPatch({ maxIterations: clampMaxIterations(parsed) });
            }
          }}
        />
      </FieldRow>
      <p className="text-xs text-muted-foreground">
        {mode === 'parallel' ? (
          <>
            Runs the body chain for all items simultaneously (up to max parallel lanes). Access the
            current item via{' '}
            <code className="font-mono bg-muted px-1 rounded text-[11px]">
              {'{{loop.currentItem}}'}
            </code>
            .
          </>
        ) : (
          <>
            Runs the next block once for each item. Access the current item via{' '}
            <code className="font-mono bg-muted px-1 rounded text-[11px]">
              {'{{previous.currentItem}}'}
            </code>{' '}
            and the index via{' '}
            <code className="font-mono bg-muted px-1 rounded text-[11px]">
              {'{{previous.currentIndex}}'}
            </code>
            .
          </>
        )}
      </p>
    </div>
  );
}
