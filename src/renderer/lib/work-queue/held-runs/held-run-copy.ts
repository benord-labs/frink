import { z } from 'zod';
import {
  buildTriggerSummary,
  type TriggerSummaryChange,
} from '../../../../shared/lib/trigger-summary';
import type { TriggerContext } from '../../../../shared/types/trigger-context';
import type { HeldRun } from './use-held-runs';

const scheduleTrigger = z.object({ _frinkTrigger: z.literal('schedule_trigger') });
const postTaskTrigger = z.object({
  _frinkTrigger: z.literal('post_task_trigger'),
  taskTitle: z.string().nullish(),
});

const changeText = (change: TriggerSummaryChange): string =>
  `${change.label}: ${[change.from, change.to].filter(Boolean).join(' → ')}`;

function heldRunOrigin(run: HeldRun, trigger: TriggerContext | null) {
  if (trigger) {
    const summary = buildTriggerSummary(trigger);
    const change = summary.changes?.[0];
    const what = [change && changeText(change), summary.title].filter(Boolean).join(' · ');
    return { source: trigger.source, what };
  }
  if (scheduleTrigger.safeParse(run.trigger_context).success)
    return { source: 'schedule', what: '' };
  const postTask = postTaskTrigger.safeParse(run.trigger_context);
  if (postTask.success) {
    return { source: 'task', what: `${postTask.data.taskTitle ?? 'A task'} finished` };
  }
  return { source: 'flow', what: '' };
}

/** A held run's row in plain words: where it came from, what happened, and which version Start
 *  runs. `trigger` is the run's webhook context, already parsed. */
export function heldRunCopy(run: HeldRun, trigger: TriggerContext | null) {
  const { source, what } = heldRunOrigin(run, trigger);
  const version = run.starts_on_latest_version ? '' : 'Runs the Flow as it was when triggered';
  return { source, description: [what, version].filter(Boolean).join(' · ') };
}
