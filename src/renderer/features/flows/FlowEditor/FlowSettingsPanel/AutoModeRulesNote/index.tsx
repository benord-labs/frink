import type { ReactElement } from 'react';
import type { FlowSettings } from '../../../../../../shared/types/flow';
import { trpc } from '../../../../../lib/trpc';

type RuleCounts = { allow: number; block: number; environment: number };

/** Plain summary of the user's own Claude Auto mode rules, or null when they have none. */
export function autoModeRulesSummary({ allow, block, environment }: RuleCounts): string | null {
  const parts = [
    allow > 0 && `${allow} allowed`,
    block > 0 && `${block} blocked`,
    environment > 0 && `${environment} about your setup`,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `Claude steps also follow the Auto Mode rules you set in Claude Code: ${parts.join(', ')}.`;
}

/** Tells the user, under Flow settings → Auto Mode, that their own rules review unattended steps.
 *  Nothing while the Flow's Auto Mode is off: no reviewer runs, so no rule applies. */
export function AutoModeRulesNote({
  settings,
}: {
  settings: FlowSettings | undefined;
}): ReactElement | null {
  const autoModeOn = settings?.autoReviewTools !== false;
  const { data } = trpc.claudeSettings.autoModeRules.useQuery(undefined, { enabled: autoModeOn });
  const summary = autoModeOn && data ? autoModeRulesSummary(data) : null;
  if (!summary) return null;
  return <p className="text-[11px] text-muted-foreground">{summary}</p>;
}
