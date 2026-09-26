import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listFlowsMock,
  getLatestVersionMock,
  startFlowRunMock,
  getConnectionLifecycleMock,
  isPluginExecutionAllowedMock,
} = vi.hoisted(() => ({
  listFlowsMock: vi.fn(),
  getLatestVersionMock: vi.fn(),
  startFlowRunMock: vi.fn(),
  getConnectionLifecycleMock: vi.fn(
    async (): Promise<{ pluginId: string; lifecycleState: string } | null> => null,
  ),
  isPluginExecutionAllowedMock: vi.fn(async () => true),
}));

vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({})) }));
// The real repo runs drizzle against a database this suite stubs to {}; the SQL is not under test.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../db/repos/flows', () => ({ listFlows: listFlowsMock }));
vi.mock('../db/repos/flow-versions', () => ({ getLatestVersion: getLatestVersionMock }));
vi.mock('./start', () => ({ startFlowRun: startFlowRunMock }));
// Same boundary as the sibling repo mocks above: the real repos run drizzle
// against a database this suite stubs to {} — the wiring under test is the
// enabled-gate lookup, not the SQL.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../db/repos/plugin-connection-lifecycle', () => ({
  getConnectionLifecycle: getConnectionLifecycleMock,
  isPluginExecutionAllowed: isPluginExecutionAllowedMock,
}));

import log from 'electron-log';
import { buildVariables } from './block-context';
import { renderTemplate } from './template-utils';
import { handleVerifiedWebhookEvent, type WebhookEventPayload } from './webhook-trigger';

const USER = 'user-1';
const INTG = 'integration-1';

function webhookNode(config: Record<string, unknown>) {
  return { nodes: [{ id: 't', blockType: 'webhook_trigger', config }], edges: [] };
}

function flow(id: string, isEnabled = true) {
  return { id, userId: USER, name: id, isEnabled, projectId: null };
}

function payload(over: Partial<WebhookEventPayload> = {}): WebhookEventPayload {
  return {
    integrationId: INTG,
    eventType: 'story_assigned',
    eventData: { provider: 'shortcut', eventType: 'story_assigned', externalUserId: 'm-1' },
    ownerExternalId: 'm-1',
    deliveryId: 'd-1',
    rawPayload: { primary_id: 46, actions: [{ name: 'Raw story title' }] },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  startFlowRunMock.mockResolvedValue({ run: {}, version: {}, isReplay: false });
  getConnectionLifecycleMock.mockResolvedValue(null);
  isPluginExecutionAllowedMock.mockResolvedValue(true);
});

describe('handleVerifiedWebhookEvent', () => {
  it('starts a matching flow with the flowId-scoped idempotency key', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned', conditions: {} }),
    });

    const res = await handleVerifiedWebhookEvent(payload());

    expect(res.fired).toBe(1);
    expect(startFlowRunMock).toHaveBeenCalledTimes(1);
    const arg = startFlowRunMock.mock.calls[0][0];
    expect(arg.flowId).toBe('flow-a');
    expect(arg.idempotencyKey).toBe('webhook:integration-1:story_assigned:d-1:flow-a');
    expect(arg.triggerContext._frinkTrigger).toBe('webhook_trigger');
    // Provider-agnostic: eventType (string) for {{trigger.event}}, and fullContent
    // is the raw provider body verbatim for {{trigger.payload.*}}.
    expect(arg.triggerContext.eventType).toBe('story_assigned');
    expect(arg.triggerContext.source).toBe('shortcut');
    expect(arg.triggerContext.fullContent).toEqual(payload().rawPayload);
  });

  it('drops the event while the owning plugin is turned off [sc-2068]', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned', conditions: {} }),
    });
    getConnectionLifecycleMock.mockResolvedValue({ pluginId: 'slack', lifecycleState: 'active' });
    isPluginExecutionAllowedMock.mockResolvedValue(false);

    const res = await handleVerifiedWebhookEvent(payload());

    expect(res).toEqual({ fired: 0, replayed: 0, skipped: 0 });
    expect(startFlowRunMock).not.toHaveBeenCalled();
  });

  it('drops queued events from a removed webhook account even after the plugin is enabled again', async () => {
    getConnectionLifecycleMock.mockResolvedValue({
      pluginId: 'huggingface',
      lifecycleState: 'disconnected',
    });
    isPluginExecutionAllowedMock.mockResolvedValue(true);
    expect(await handleVerifiedWebhookEvent(payload())).toEqual({
      fired: 0,
      replayed: 0,
      skipped: 0,
    });
    expect(startFlowRunMock).not.toHaveBeenCalled();
    expect(listFlowsMock).not.toHaveBeenCalled();
  });

  it('does not execute an event when its lifecycle cannot be read', async () => {
    getConnectionLifecycleMock.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(handleVerifiedWebhookEvent(payload())).rejects.toThrow('Database unavailable');
    expect(startFlowRunMock).not.toHaveBeenCalled();
  });

  it('fires normally for an enabled plugin and for providers with no lifecycle row [sc-2068]', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned', conditions: {} }),
    });
    getConnectionLifecycleMock.mockResolvedValue({ pluginId: 'slack', lifecycleState: 'active' });
    isPluginExecutionAllowedMock.mockResolvedValue(true);

    expect((await handleVerifiedWebhookEvent(payload())).fired).toBe(1);

    // api_token providers write no lifecycle rows — they pass through ungated.
    getConnectionLifecycleMock.mockResolvedValue(null);
    expect((await handleVerifiedWebhookEvent(payload({ deliveryId: 'd-2' }))).fired).toBe(1);
  });

  it('stores the raw provider body verbatim as fullContent (any provider)', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned' }),
    });

    const rawPayload = {
      primary_id: 46,
      actions: [{ name: 'Fix navigation bug', changes: { owner_ids: { adds: ['m-1'] } } }],
      references: [{ entity_type: 'story', name: 'Fix navigation bug' }],
    };
    await handleVerifiedWebhookEvent(payload({ rawPayload }));

    // {{trigger.payload.*}} resolves against the exact provider webhook body —
    // e.g. {{trigger.payload.actions.0.name}} renders the story title.
    const ctx = startFlowRunMock.mock.calls[0][0].triggerContext as {
      fullContent: Record<string, unknown>;
    };
    expect(ctx.fullContent).toEqual(rawPayload);
  });

  it('falls back to an empty fullContent when no rawPayload is forwarded', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned' }),
    });

    await handleVerifiedWebhookEvent(payload({ rawPayload: undefined }));

    expect(startFlowRunMock.mock.calls[0][0].triggerContext.fullContent).toEqual({});
  });

  it('fires every matching flow without idempotency collision (N-flow fan-out)', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a'), flow('flow-b')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned' }),
    });

    const res = await handleVerifiedWebhookEvent(payload());

    expect(res.fired).toBe(2);
    const keys = startFlowRunMock.mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('forwards the same raw fullContent to every matched flow (fan-out)', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a'), flow('flow-b')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned' }),
    });
    const rawPayload = { primary_id: 7, actions: [{ name: 'Shared title' }] };

    await handleVerifiedWebhookEvent(payload({ rawPayload }));

    expect(startFlowRunMock).toHaveBeenCalledTimes(2);
    for (const call of startFlowRunMock.mock.calls) {
      expect(call[0].triggerContext.fullContent).toEqual(rawPayload);
    }
  });

  it('uses an empty fullContent for a non-object rawPayload (guard, no throw)', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned' }),
    });

    await handleVerifiedWebhookEvent(payload({ rawPayload: 'not-an-object' }));

    expect(startFlowRunMock.mock.calls[0][0].triggerContext.fullContent).toEqual({});
  });

  it('skips disabled flows', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a', false)]);
    await handleVerifiedWebhookEvent(payload());
    expect(startFlowRunMock).not.toHaveBeenCalled();
  });

  it('skips flows whose webhook_trigger targets a different integration/event', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: 'other', eventType: 'story_assigned' }),
    });
    await handleVerifiedWebhookEvent(payload());
    expect(startFlowRunMock).not.toHaveBeenCalled();
  });

  it('logs why a flow was skipped once per (flow, event), not once per delivery', async () => {
    const info = vi.spyOn(log, 'info');
    listFlowsMock.mockResolvedValue([flow('flow-stale')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_deleted' }),
    });

    await handleVerifiedWebhookEvent(payload({ deliveryId: 'd-1' }));
    await handleVerifiedWebhookEvent(payload({ deliveryId: 'd-2' }));

    const skips = () => info.mock.calls.filter((c) => c[0] === '[WebhookTrigger] flow skipped');
    expect(skips()).toHaveLength(1);
    expect(skips()[0]?.[1]).toEqual({
      flowId: 'flow-stale',
      eventType: 'story_assigned',
      reason: 'no trigger in this flow is bound to this event',
    });

    // Rebound to the live event but filtered out: a different reason for the same pair is news.
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({
        integrationId: INTG,
        eventType: 'story_assigned',
        conditions: { assignee: 'me' },
      }),
    });
    await handleVerifiedWebhookEvent(
      payload({ deliveryId: 'd-3', ownerExternalId: 'someone-else' }),
    );
    expect(skips()).toHaveLength(2);
    expect(skips()[1]?.[1]).toMatchObject({
      reason: 'the event did not match the trigger filters',
    });
    info.mockRestore();
  });

  it('applies conditions: assignee=me only matches when ownerExternalId is in owner_ids', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({
        integrationId: INTG,
        eventType: 'story_assigned',
        conditions: { assignee: 'me' },
      }),
    });

    await handleVerifiedWebhookEvent(
      payload({
        ownerExternalId: 'm-1',
        eventData: {
          provider: 'shortcut',
          eventType: 'story_assigned',
          externalUserId: 'm-1',
          owner_ids: ['someone-else'],
        },
      }),
    );
    expect(startFlowRunMock).not.toHaveBeenCalled();

    await handleVerifiedWebhookEvent(
      payload({
        ownerExternalId: 'm-1',
        eventData: {
          provider: 'shortcut',
          eventType: 'story_assigned',
          externalUserId: 'm-1',
          owner_ids: ['m-1'],
        },
      }),
    );
    expect(startFlowRunMock).toHaveBeenCalledTimes(1);
  });

  it('survives a startFlowRun error and keeps firing other flows', async () => {
    listFlowsMock.mockResolvedValue([flow('flow-a'), flow('flow-b')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned' }),
    });
    startFlowRunMock.mockRejectedValueOnce(new Error('disabled'));

    const res = await handleVerifiedWebhookEvent(payload());
    expect(res.fired).toBe(1);
    expect(res.skipped).toBe(1);
  });
});

describe('handleVerifiedWebhookEvent idempotency key', () => {
  beforeEach(() => {
    listFlowsMock.mockResolvedValue([flow('flow-a')]);
    getLatestVersionMock.mockResolvedValue({
      graph: webhookNode({ integrationId: INTG, eventType: 'story_assigned', conditions: {} }),
    });
  });

  it('starts a matching flow', async () => {
    const res = await handleVerifiedWebhookEvent(payload());

    expect(res.fired).toBe(1);
    expect(startFlowRunMock.mock.calls[0][0].idempotencyKey).toBe(
      'webhook:integration-1:story_assigned:d-1:flow-a',
    );
  });
});

// The LIVE on-machine render chain that backs {{trigger.payload.*}}:
// buildVariables (applyTriggerAliases) → renderTemplate, against the raw provider
// body stored as fullContent. (block-context + template-utils have no own tests;
// the folder-structure rule blocks new files in flows/, so they live here.)
function render(triggerContext: Record<string, unknown>, template: string): string {
  return renderTemplate(template, buildVariables({ triggerContext, previousOutput: undefined }));
}

describe('trigger payload rendering (local chain)', () => {
  it('resolves {{trigger.payload.*}} against the raw webhook body (fullContent alias)', () => {
    const ctx = {
      eventType: 'story_assigned',
      fullContent: { primary_id: 46, actions: [{ name: 'Fix nav bug' }] },
    };
    expect(render(ctx, 'Title: {{trigger.payload.actions.0.name}}')).toBe('Title: Fix nav bug');
    expect(render(ctx, 'id {{trigger.payload.primary_id}}')).toBe('id 46');
  });

  it('aliases {{trigger.event}} from eventType', () => {
    expect(render({ eventType: 'story_assigned', fullContent: {} }, '{{trigger.event}}')).toBe(
      'story_assigned',
    );
  });

  it('renders {{trigger.payload.*}} empty when fullContent has no such field', () => {
    // Shortcut webhooks carry no top-level name/description. An absent path renders empty so the
    // placeholder text itself can never be mistaken for provider data (sc-2706).
    expect(render({ eventType: 'x', fullContent: {} }, '{{trigger.payload.name}}')).toBe('');
  });

  it('does not let a malicious raw body escape via prototype-pollution paths', () => {
    const ctx = {
      eventType: 'x',
      fullContent: JSON.parse('{"__proto__":{"polluted":"x"},"safe":"ok"}') as Record<
        string,
        unknown
      >,
    };
    // A blocked segment resolves to nothing, so it renders empty — the guarantee that matters is
    // that the polluted value never reaches the output.
    expect(render(ctx, '{{trigger.payload.__proto__.polluted}}')).toBe('');
    expect(render(ctx, '{{trigger.payload.constructor.name}}')).toBe('');
    expect(render(ctx, '{{trigger.payload.safe}}')).toBe('ok');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('caps deep raw-body traversal at MAX_PATH_DEPTH (5 path segments)', () => {
    // Raw provider bodies nest deep; trigger.payload.a.b.c (5 segments) resolves,
    // one level deeper (6) is blocked and renders empty rather than leaking the value.
    const ctx = { eventType: 'x', fullContent: { a: { b: { c: { d: 'deep' } } } } };
    expect(render(ctx, '{{trigger.payload.a.b.c}}')).toBe(JSON.stringify({ d: 'deep' }));
    expect(render(ctx, '{{trigger.payload.a.b.c.d}}')).toBe('');
  });
});
