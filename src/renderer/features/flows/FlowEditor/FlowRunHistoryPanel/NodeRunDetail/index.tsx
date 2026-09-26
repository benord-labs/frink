/**
 * Expanded inline detail for a single flow node run (errors, outputs, timing).
 */

import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { FileCode2 } from 'lucide-react';
import { useMemo } from 'react';
import type { DbNodeRun } from '../../../../../../shared/types/flow-run';
import { openFileAtom } from '../../../../../features/code-editor';
import { cn } from '../../../../../lib/utils';
import { formatDuration } from '../format-duration';
import { wallDurationMs as computeWallDurationMs } from '../wall-duration-ms';
import { FanOutResultsTable } from './FanOutResultsTable';
import { NodeRunDetailEarly } from './node-run-detail-early';
import { parseNodeOutput } from './parse-node-output';
import { TruncatedJsonBlock } from './TruncatedJsonBlock';

const PATH_SEGMENT_SPLIT_RE = /[/\\]/;

type NodeRunDetailProps = {
  nodeRun: DbNodeRun;
  /** 1-based lane index when this row is a fan-out child */
  laneNumber?: number;
  laneTotal?: number;
  /** Local custom node entrypoint (absolute); shown on failure when available. */
  customEntrypointPath?: string | null;
  nodeLabelById: ReadonlyMap<string, string>;
};

function prettyOutputs(outputs: Record<string, unknown>): string {
  try {
    return JSON.stringify(outputs, null, 2);
  } catch {
    return String(outputs);
  }
}

export function NodeRunDetail({
  nodeRun,
  laneNumber,
  laneTotal,
  customEntrypointPath,
  nodeLabelById,
}: NodeRunDetailProps) {
  const { status, started_at, completed_at, node_output } = nodeRun;
  const openFile = useSetAtom(openFileAtom);
  const parsed = useMemo(() => parseNodeOutput(node_output), [node_output]);
  const wallMs = useMemo(
    () => computeWallDurationMs(started_at, completed_at),
    [started_at, completed_at],
  );

  const outputsPretty = useMemo(() => {
    if (!parsed.success) return null;
    const o = parsed.output.outputs;
    if (!o || Object.keys(o).length === 0) return null;
    // Fan-out completion outputs are rendered as a structured table, not raw JSON
    if (o._fanOutState === 'completed') return null;
    return prettyOutputs(o);
  }, [parsed]);

  const fanOutResults = useMemo(() => {
    if (!parsed.success) return null;
    const o = parsed.output.outputs;
    if (o?._fanOutState !== 'completed') return null;
    return {
      results: Array.isArray(o.results) ? (o.results as unknown[]) : [],
      totalCount: typeof o.totalCount === 'number' ? o.totalCount : 0,
    };
  }, [parsed]);

  if (
    status === 'running' ||
    status === 'pending' ||
    status === 'cancelled' ||
    status === 'skipped' ||
    status === 'awaiting_input' ||
    status === 'blocked' ||
    !parsed.success
  ) {
    return <NodeRunDetailEarly nodeRun={nodeRun} parsed={parsed} wallDurationMs={wallMs} />;
  }

  const { output } = parsed;
  const exitCode = output.outputs?.exitCode;

  const isFailed = status === 'failed';
  const shell = isFailed
    ? 'border-destructive/25 bg-destructive/6'
    : 'border-border/40 bg-muted/20';

  return (
    <div className={cn('mt-1 space-y-2 rounded-md border px-2 py-1.5 text-[10px]', shell)}>
      {laneNumber != null ? (
        <p className="text-muted-foreground">
          {laneTotal != null && laneTotal > 0
            ? `Lane ${laneNumber} of ${laneTotal}`
            : `Lane ${laneNumber}`}
        </p>
      ) : null}

      {wallMs != null && wallMs >= 0 && (status === 'completed' || status === 'failed') && (
        <p className="text-muted-foreground">Wall time: {formatDuration(wallMs)}</p>
      )}

      {status === 'failed' && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {output.error?.code ? (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                {output.error.code}
              </span>
            ) : null}
            {exitCode != null && exitCode !== '' ? (
              <span className="text-muted-foreground">Exit code: {String(exitCode)}</span>
            ) : null}
            {output.error ? (
              <span className="text-muted-foreground/70">
                {output.error.retryable ? 'Retryable' : 'Not retryable'}
              </span>
            ) : null}
          </div>
          <p className="font-mono text-[10px] text-destructive wrap-break-word">
            {output.error?.message?.trim() ? output.error.message.trim() : 'Unknown error'}
          </p>
          {customEntrypointPath ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <code className="max-w-full truncate text-[9px] text-muted-foreground">
                {customEntrypointPath}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-6 gap-1 text-[10px]"
                onClick={() => {
                  const name =
                    customEntrypointPath.split(PATH_SEGMENT_SPLIT_RE).pop() ?? 'entrypoint';
                  openFile({
                    path: customEntrypointPath,
                    name,
                    intent: 'preview',
                  });
                }}
              >
                <FileCode2 className="h-3 w-3" aria-hidden />
                View code
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {status === 'completed' && (
        <p className="text-muted-foreground">
          Engine duration: {formatDuration(output.durationMs ?? 0)}
        </p>
      )}

      {fanOutResults != null ? (
        <FanOutResultsTable
          results={fanOutResults.results}
          totalCount={fanOutResults.totalCount}
          nodeLabelById={nodeLabelById}
        />
      ) : outputsPretty != null ? (
        <TruncatedJsonBlock label="Outputs" value={outputsPretty} />
      ) : null}

      {status === 'failed' ? <div className="h-1" aria-hidden /> : null}
    </div>
  );
}
