import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../../../shared/integrations/providers';
import { readyRunFirstRule } from '../../../../shared/lib/flow-admission/run-first-rule';
import { runFirstDetails } from './run-first-details';

const values = (details: ReturnType<typeof runFirstDetails>) =>
  details.suggestions.map((s) => s.value);

describe('runFirstDetails', () => {
  it('offers a webhook provider its friendly names, then its sample payload values', () => {
    const shortcut = runFirstDetails({
      triggerBlockType: 'webhook_trigger',
      provider: 'shortcut',
      eventType: 'story_assigned',
    });

    expect(values(shortcut)).toContain('trigger.story.title');
    expect(values(shortcut)).toContain('trigger.payload.actions.0.name');
    expect(shortcut.suggestions[0]).toEqual({ value: 'trigger.story.title', label: 'Story title' });
    expect(shortcut.noDetails).toBe(false);
  });

  it('offers a generic webhook the fields of its sample body, never past five segments', () => {
    const generic = runFirstDetails({
      triggerBlockType: 'webhook_trigger',
      provider: 'generic_webhook',
      eventType: 'received',
    });

    expect(values(generic)).toEqual([
      'trigger.payload.id',
      'trigger.payload.source',
      'trigger.payload.message',
    ]);
    expect(generic.suggestions[1]?.label).toBe('e.g. my-system');
    for (const value of values(
      runFirstDetails({
        triggerBlockType: 'webhook_trigger',
        provider: 'linear',
        eventType: 'issue_created',
      }),
    )) {
      expect(value.split('.').length).toBeLessThanOrEqual(5);
    }
  });

  it('offers post-task runs the details they save, and batch runs their declared inputs', () => {
    expect(values(runFirstDetails({ triggerBlockType: 'post_task_trigger' }))).toEqual([
      'trigger.taskTitle',
      'trigger.taskStatus',
      'trigger.projectId',
    ]);
    expect(
      values(runFirstDetails({ triggerBlockType: 'manual_trigger', batchKeys: ['ticketId'] })),
    ).toEqual(['trigger.ticketId']);
  });

  it('says a scheduled flow has nothing to check, and a webhook with no provider yet offers nothing', () => {
    expect(runFirstDetails({ triggerBlockType: 'schedule_trigger' })).toEqual({
      suggestions: [],
      noDetails: true,
    });
    expect(runFirstDetails({ triggerBlockType: 'webhook_trigger' }).suggestions).toEqual([]);
  });

  it('only ever suggests a detail the rule can read, for every catalog event', () => {
    const unreadable = PROVIDERS.flatMap((provider) =>
      (provider.events ?? []).flatMap((event) =>
        runFirstDetails({
          triggerBlockType: 'webhook_trigger',
          provider: provider.id,
          eventType: event.id,
        })
          .suggestions.map((s) => s.value)
          .filter((detail) => !readyRunFirstRule([{ detail, operator: 'equals', value: 'x' }])),
      ),
    );
    expect(unreadable).toEqual([]);
  });
});
