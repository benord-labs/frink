import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { triggerRulesRouter } from './trigger-rules';

const caller = () => triggerRulesRouter.createCaller({ getWindow: () => null });

describe('triggerRulesRouter — gated for v1 local-first', () => {
  it('create throws PRECONDITION_FAILED', async () => {
    await expect(
      caller().create({
        integrationId: '11111111-1111-4111-8111-111111111111',
        name: 'rule',
        eventType: 'story_moved',
        actionConfig: { start_mode: 'plan' },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('update throws PRECONDITION_FAILED', async () => {
    await expect(
      caller().update({
        ruleId: '22222222-2222-4222-8222-222222222222',
        actionConfig: { start_mode: 'execute' },
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('toggle throws PRECONDITION_FAILED', async () => {
    await expect(
      caller().toggle({ ruleId: '22222222-2222-4222-8222-222222222222', isActive: false }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('read procs return safe defaults instead of throwing', async () => {
    expect(await caller().listAll()).toEqual([]);
    expect(await caller().listByIntegration({ integrationId: 'x' })).toEqual([]);
    expect(await caller().get({ ruleId: 'x' })).toBeNull();
  });

  it('returns Linear event types for provider contract', async () => {
    const eventTypes = await caller().getEventTypes({ provider: 'linear' });

    expect(eventTypes.map((e) => ({ id: e.id, label: e.label }))).toEqual([
      { id: 'issue_status_changed', label: 'Issue status changed' },
      { id: 'issue_created', label: 'New issue created' },
      { id: 'issue_commented', label: 'Comment added' },
    ]);
  });

  it('lists every catalog provider, so a data-driven row (PostHog) needs no allowlist entry', async () => {
    const eventTypes = await caller().getEventTypes({ provider: 'posthog' });

    expect(eventTypes.map((e) => e.id)).toEqual(['event_matched', 'error_captured']);
    await expect(caller().getEventTypes({ provider: 'not-a-provider' })).rejects.toThrow();
  });
});
