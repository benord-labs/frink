import { describe, expect, it } from 'vitest';
import { isValidTriggerContext, withTriggerContextDefaults } from './trigger-context';

/**
 * The flow-webhook producer (`buildWebhookTriggerContext`) sets only envelope fields +
 * `fullContent` — it never sets the legacy rule-based fields (`sourceAccountName`,
 * `triggerRuleId`, `triggerRuleName`) because flow-as-trigger has no rule. The validator
 * must accept that shape, else the Work Queue "View original content" menu (gated on a
 * non-null parsed context) stays hidden.
 */
describe('isValidTriggerContext — flow-webhook shape (no legacy rule fields)', () => {
  const webhookShape = {
    source: 'shortcut',
    sourceAccountId: 'integration-uuid',
    eventType: 'story_update',
    triggeredBy: { externalUserId: 'member-1' },
    timestamp: '2026-06-01T12:00:00.000Z',
    fullContent: { primary_id: 4821, actions: [{ name: 'A story', entity_type: 'story' }] },
  };

  it('accepts a context lacking sourceAccountName / triggerRuleId / triggerRuleName', () => {
    expect(isValidTriggerContext(webhookShape)).toBe(true);
  });

  it('still rejects a present-but-wrong-typed legacy field', () => {
    expect(isValidTriggerContext({ ...webhookShape, triggerRuleName: 42 })).toBe(false);
    expect(isValidTriggerContext({ ...webhookShape, sourceAccountName: { x: 1 } })).toBe(false);
  });

  it('still requires the core envelope fields', () => {
    const { eventType: _e, ...noEvent } = webhookShape;
    expect(isValidTriggerContext(noEvent)).toBe(false);
    const { fullContent: _f, ...noPayload } = webhookShape;
    expect(isValidTriggerContext(noPayload)).toBe(false);
    expect(isValidTriggerContext({ ...webhookShape, source: 'not-a-provider' })).toBe(false);
  });

  it('still rejects a minimal _config-only flow blob (manual/schedule/post_task)', () => {
    expect(isValidTriggerContext({ _config: { startMode: 'plan' } })).toBe(false);
  });

  it('accepts the legacy enriched (rule-based) shape too — relaxed ⊇ strict', () => {
    expect(
      isValidTriggerContext({
        ...webhookShape,
        sourceAccountName: 'Acme',
        triggerRuleId: 'rule-1',
        triggerRuleName: 'When story assigned',
      }),
    ).toBe(true);
  });

  it('withTriggerContextDefaults preserves fullContent + defaults autoStart', () => {
    const out = withTriggerContextDefaults(webhookShape as never);
    expect(out.fullContent).toEqual(webhookShape.fullContent);
    expect(out.autoStart).toBe(false);
  });
});
