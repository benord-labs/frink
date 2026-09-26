/**
 * Ghost Run header strip — an honest banner above the canvas summarising the static pre-flight
 * analysis (real finding counts, not fabricated cost/time). Gated on `ghostRunHeaderStateAtom`; the
 * parent mounts it only while a rehearsal is active. The chevron toggles a findings list — each row
 * shows the node label + why + fix and focuses that node on click.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { ChevronDown, FlaskConical } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactElement, useState } from 'react';
import {
  type GhostRunHeaderState,
  ghostRunHeaderStateAtom,
  type RehearsalFinding,
} from '../../../lib/flow-rehearsal';
import { cn } from '../../../lib/utils';

type GhostRunHeaderStripProps = {
  /** Focus + select the offending node when a finding row is clicked. */
  onFocusNode?: (nodeId: string) => void;
};

/** Honest one-line summary: real finding counts, never a fabricated token/time estimate. */
function summaryLine(findingCount: number, affectedNodeCount: number): string {
  if (findingCount === 0) return 'No issues found — looks ready';
  const issues = `${findingCount} ${findingCount === 1 ? 'issue' : 'issues'}`;
  const nodes = `${affectedNodeCount} ${affectedNodeCount === 1 ? 'step' : 'steps'}`;
  return `${issues} across ${nodes}`;
}

const SEVERITY_DOT: Record<RehearsalFinding['severity'], string> = {
  error: 'bg-destructive',
  warn: 'bg-amber-500',
  info: 'bg-muted-foreground',
};

/** The expandable list of findings — each row focuses its node on click. */
function FindingsList({
  findings,
  onFocusNode,
}: {
  findings: RehearsalFinding[];
  onFocusNode?: (nodeId: string) => void;
}): ReactElement {
  return (
    <ul className="max-h-48 overflow-y-auto border-t border-amber-500/15 px-2 py-1">
      {findings.map((f) => (
        <li key={`${f.nodeId}:${f.rule}`}>
          <Button
            type="button"
            variant="ghost"
            className="flex h-auto w-full items-start gap-2 rounded-md px-2 py-1.5 text-left"
            onClick={() => onFocusNode?.(f.nodeId)}
            title="Focus this step"
          >
            <span
              className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[f.severity])}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">
                {f.nodeLabel}
              </span>
              <span className="block text-[11px] leading-snug text-muted-foreground">{f.why}</span>
              <span className="block text-[11px] leading-snug text-foreground/70">
                Fix: {f.fix}
              </span>
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The one-line summary: flask + counts + the show/hide-findings toggle. */
function SummaryRow({
  header,
  isClean,
  expanded,
  onToggle,
}: {
  header: GhostRunHeaderState;
  isClean: boolean;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs',
        isClean ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400',
      )}
    >
      <span className="flex items-center gap-1.5 font-medium">
        <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Rehearsal
      </span>
      <span className="font-semibold">
        {summaryLine(header.findingCount, header.affectedNodeCount)}
      </span>
      {header.errorCount > 0 ? (
        <span className="font-medium text-red-700 dark:text-red-300">
          {header.errorCount} blocking {header.errorCount === 1 ? 'error' : 'errors'}
        </span>
      ) : null}
      <span className="text-muted-foreground">
        {header.nodeCount} {header.nodeCount === 1 ? 'step' : 'steps'} analysed
      </span>
      {header.findingCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto h-6 gap-1 px-1.5 text-[11px]"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'} findings
          <ChevronDown
            className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')}
            aria-hidden
          />
        </Button>
      ) : null}
    </div>
  );
}

export function GhostRunHeaderStrip({
  onFocusNode,
}: GhostRunHeaderStripProps): ReactElement | null {
  const header = useAtomValue(ghostRunHeaderStateAtom);
  const [expanded, setExpanded] = useState(true);

  const hasFindings = (header?.findingCount ?? 0) > 0;
  const isClean = header !== null && !hasFindings;

  return (
    <AnimatePresence>
      {header ? (
        <motion.div
          key="ghost-run-header"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
          className={cn(
            'overflow-hidden border-b',
            isClean
              ? 'border-emerald-500/20 bg-emerald-500/10'
              : 'border-amber-500/20 bg-amber-500/10',
          )}
        >
          <SummaryRow
            header={header}
            isClean={isClean}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          />

          {hasFindings && expanded ? (
            <FindingsList findings={header.findings} onFocusNode={onFocusNode} />
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
