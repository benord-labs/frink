import { memo, type ReactElement, useId } from 'react';
import { getBlockRegistration } from '../../../../../shared/lib/block-registry';
import type { FlowSemanticChange } from '../../../../../shared/types/flows/flow-change-presentation';
import {
  type FlowChangeOutlineModel,
  type FlowOutlineRoute,
  type FlowOutlineStep,
  visibleFlowChanges,
} from '../../../../lib/flows/flow-change-outline';
import { cn } from '../../../../lib/utils';
import { ChangeDetails } from './ChangeDetails';
import { Omission, RouteTerminal } from './RouteAnnotations';

type Props = { outline: FlowChangeOutlineModel };
type ChangesProps = { changes: FlowSemanticChange[] };
type RouteProps = { route: FlowOutlineRoute; routeNumber?: number; showHeading?: boolean };
type BranchesProps = { branches: FlowOutlineRoute[]; depth?: number };

const ATTENTION_STATUSES = new Set(['failed', 'skipped', 'unknown']);
const PURPOSE_SENTENCE_BOUNDARY = /[.(]/;
const STEP_PURPOSE = new Map([
  ['start_task', 'Prepares the task workspace'],
  ['agent', 'Runs the agent instructions'],
  ['chat_reply', 'Posts a reply to the source chat'],
]);
const LIST_RESET_CLASS = 'm-0 list-none p-0';
const RESPONSIVE_HEADING_CLASS =
  'flex min-w-0 items-baseline justify-between gap-2.5 @max-[420px]:flex-col @max-[420px]:items-start @max-[420px]:gap-0';

function purposeForStep(step: FlowOutlineStep): string {
  const registeredPurpose = getBlockRegistration(step.blockType)?.description;
  return (
    STEP_PURPOSE.get(step.blockType) ??
    registeredPurpose?.split(PURPOSE_SENTENCE_BOUNDARY)[0]?.trim() ??
    'Runs this custom Flow step'
  );
}

function omittedRouteText(count: number): string {
  return `${count} more ${count === 1 ? 'route' : 'routes'} not shown`;
}

function Branches({ branches, depth = 0 }: BranchesProps): ReactElement | null {
  if (branches.length === 0) return null;
  return (
    <ol
      className={cn(
        LIST_RESET_CLASS,
        'my-[3px]',
        depth === 0 && 'ml-[17px]',
        depth === 1 && 'ml-[9px]',
      )}
    >
      {branches.map((branch) => (
        <li
          className="min-w-0 border-l border-border/70 py-1 pl-[9px] [&+&]:mt-0.5"
          key={branch.id}
        >
          <div
            className={cn(
              RESPONSIVE_HEADING_CLASS,
              'text-[10px] font-medium leading-[14px] text-foreground',
            )}
          >
            <span>{branch.label ?? 'Path'}</span>
            <ChangeDetails changes={branch.changes} />
          </div>
          <StepList branchDepth={depth + 1} hideFirstRelation steps={branch.steps} />
          <Omission
            anchor={branch.steps.at(-1)?.label ?? branch.label ?? 'this branch'}
            count={branch.omittedAfter}
          />
          <RouteTerminal terminal={branch.terminal} />
        </li>
      ))}
    </ol>
  );
}

function Step({
  branchDepth,
  hideRelation,
  step,
}: {
  branchDepth: number;
  hideRelation?: boolean;
  step: FlowOutlineStep;
}): ReactElement {
  const relation = step.relationBefore === 'Then' ? undefined : step.relationBefore;
  const showsRelation = Boolean(relation && !hideRelation);
  const coLocatedChanges = showsRelation
    ? step.changes
    : [...step.relationChanges, ...step.changes];
  const hasVisibleChanges = visibleFlowChanges(coLocatedChanges).length > 0;
  return (
    <li className="relative min-w-0 after:absolute after:bottom-[-1px] after:left-1 after:top-[19px] after:z-0 after:w-px after:bg-border/70 after:content-[''] last:after:hidden">
      {showsRelation ? (
        <div className="ml-[18px] grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)] gap-2 py-0.5 text-[9px] font-medium leading-3 text-muted-foreground">
          <span className="min-w-0 wrap-anywhere">{relation}</span>
          <ChangeDetails changes={step.relationChanges} />
        </div>
      ) : null}
      <div
        className="grid min-w-0 grid-cols-[10px_minmax(0,1fr)] items-start gap-2 py-1.5"
        data-slot="flow-change-step"
      >
        <span
          aria-hidden="true"
          className={cn(
            'z-[1] mt-1 size-2 rounded-full border border-muted-foreground/70 bg-card',
            hasVisibleChanges &&
              'border-[hsl(var(--status-online-text))] bg-[hsl(var(--status-online-text))]',
            step.branches.length > 0 && 'rotate-45 rounded-[2px]',
          )}
          data-slot="flow-change-marker"
        />
        <span className="flex min-w-0 flex-col gap-px text-[11px] leading-[15px] wrap-anywhere">
          <span className={RESPONSIVE_HEADING_CLASS}>
            <strong className="font-medium text-foreground">{step.label}</strong>
            <span className="shrink-0 text-[10px] leading-[14px] text-muted-foreground">
              {step.blockTypeLabel}
            </span>
          </span>
          <span className="text-[10px] leading-[14px] text-muted-foreground">
            {purposeForStep(step)}
          </span>
          <ChangeDetails changes={coLocatedChanges} />
        </span>
      </div>
      <Omission anchor={step.label} count={step.omittedAfter} />
      <Branches branches={step.branches} depth={branchDepth} />
    </li>
  );
}

function StepList({
  branchDepth = 0,
  hideFirstRelation,
  steps,
}: {
  branchDepth?: number;
  hideFirstRelation?: boolean;
  steps: FlowOutlineStep[];
}): ReactElement | null {
  if (steps.length === 0) return null;
  return (
    <ol className={LIST_RESET_CLASS}>
      {steps.map((step, index) => (
        <Step
          branchDepth={branchDepth}
          hideRelation={hideFirstRelation && index === 0}
          key={step.id}
          step={step}
        />
      ))}
    </ol>
  );
}

function Route({ route, routeNumber, showHeading }: RouteProps): ReactElement {
  const heading = route.label ?? (routeNumber == null ? undefined : `Path ${routeNumber}`);
  const anchor = route.steps.at(-1)?.label ?? heading ?? 'this route';
  return (
    <div className="min-w-0 pt-1.5 [&+&]:mt-1.5 [&+&]:border-t [&+&]:border-border/40">
      {showHeading && heading ? (
        <div className={cn(RESPONSIVE_HEADING_CLASS, 'pb-[3px]')}>
          <h5 className="m-0 text-[11px] font-semibold leading-4 text-foreground">{heading}</h5>
          <ChangeDetails changes={route.changes} />
        </div>
      ) : (
        <ChangeDetails changes={route.changes} />
      )}
      <StepList steps={route.steps} />
      <Omission anchor={anchor} count={route.omittedAfter} />
      <RouteTerminal terminal={route.terminal} />
    </div>
  );
}

function countVisibleSteps(routes: FlowOutlineRoute[]): number {
  let count = 0;
  for (const route of routes) {
    count += route.steps.length;
    for (const step of route.steps) count += countVisibleSteps(step.branches);
  }
  return count;
}

function countText(outline: FlowChangeOutlineModel): string {
  const visibleCount = countVisibleSteps(outline.routes);
  const stepCopy =
    outline.omittedNodeCount > 0
      ? `${visibleCount} of ${outline.totalNodeCount} steps`
      : `${outline.totalNodeCount} ${outline.totalNodeCount === 1 ? 'step' : 'steps'}`;
  const pathCopy = `${outline.branchCount} ${outline.branchCount === 1 ? 'path' : 'paths'}`;
  return outline.branchCount > 0 ? `${stepCopy}, ${pathCopy}` : stepCopy;
}

function unplacedHeading(changes: FlowSemanticChange[]): string {
  if (changes.some((change) => ATTENTION_STATUSES.has(change.status))) return 'Needs attention';
  if (changes.every((change) => change.status === 'applied' && change.action === 'remove')) {
    return 'Removed from Flow';
  }
  return 'Other changes';
}

function ChangeSection({
  changes,
  heading,
}: ChangesProps & { heading: string }): ReactElement | null {
  if (changes.length === 0) return null;
  return (
    <section className="mt-2 min-w-0 border-t border-border/45 pt-2">
      <h5 className="m-0 text-[11px] font-semibold leading-4 text-foreground">{heading}</h5>
      <ul className={LIST_RESET_CLASS}>
        {changes.map((change) => (
          <li
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)] gap-2.5 py-[3px] text-[11px] leading-[15px] wrap-anywhere @max-[420px]:grid-cols-[minmax(0,1fr)]"
            key={`${change.kind}:${change.operationIndex}`}
          >
            <strong className="font-medium text-foreground">{change.label}</strong>
            <ChangeDetails changes={[change]} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export const FlowChangeOutline = memo(function FlowChangeOutline({ outline }: Props): ReactElement {
  const headingId = useId();
  const heading = outline.scope === 'changes-only' ? outline.heading : 'How this Flow runs';
  const hasContent =
    outline.routes.length > 0 ||
    outline.settingsChanges.length > 0 ||
    outline.unplacedChanges.length > 0;
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 px-3.5 pt-2.5 pb-3.5 text-foreground @max-[420px]:px-2.5"
      data-scope={outline.scope}
    >
      <header className="flex min-w-0 items-baseline justify-between gap-2.5 border-b border-border/45 pb-2">
        <h4 className="m-0 text-[11px] font-semibold leading-4 text-foreground" id={headingId}>
          {heading}
        </h4>
        {outline.totalNodeCount > 0 && outline.scope !== 'changes-only' ? (
          <span className="text-right text-[10px] leading-[14px] text-muted-foreground">
            {countText(outline)}
          </span>
        ) : null}
      </header>

      {outline.omittedRouteCount > 0 ? (
        <p className="mt-1.5 mb-0 text-[10px] leading-[14px] text-muted-foreground">
          {omittedRouteText(outline.omittedRouteCount)}
        </p>
      ) : null}
      {outline.routes.map((route, index) => (
        <Route
          key={route.id}
          route={route}
          routeNumber={index + 1}
          showHeading={outline.routes.length > 1}
        />
      ))}
      <ChangeSection changes={outline.settingsChanges} heading="Flow settings" />
      <ChangeSection
        changes={outline.unplacedChanges}
        heading={unplacedHeading(outline.unplacedChanges)}
      />
      {!hasContent ? (
        <p className="m-0 pt-[7px] text-[11px] leading-[15px] text-muted-foreground">
          No flow structure was available.
        </p>
      ) : null}
    </section>
  );
});
