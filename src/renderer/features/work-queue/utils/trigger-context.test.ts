import { describe, expect, it } from 'vitest';
import type { TriggerContext } from '../../../../shared/types/trigger-context';
import { asGmailFullContent, parseTriggerContext } from './trigger-context';

function createContext(): TriggerContext {
  return {
    source: 'gmail',
    sourceAccountId: 'acc',
    sourceAccountName: 'gmail',
    triggerRuleId: 'rule',
    triggerRuleName: 'Email rule',
    eventType: 'email_received',
    triggeredBy: {},
    timestamp: new Date().toISOString(),
    fullContent: {},
    autoStart: false,
  };
}

describe('parseTriggerContext', () => {
  it('returns object input as-is', () => {
    const ctx = createContext();
    expect(parseTriggerContext(ctx)).toEqual(ctx);
  });

  it('returns null when object input lacks required TriggerContext fields', () => {
    expect(parseTriggerContext({ source: 'gmail' } as unknown as TriggerContext)).toBeNull();
  });

  it('returns null when source is not a known TriggerSource', () => {
    const ctx = createContext();
    expect(
      parseTriggerContext({
        ...ctx,
        source: 'not-a-real-source' as unknown as TriggerContext['source'],
      }),
    ).toBeNull();
  });

  it('defaults autoStart to false when omitted on an otherwise valid context', () => {
    const ctx: TriggerContext = {
      source: 'gmail',
      sourceAccountId: 'acc',
      sourceAccountName: 'gmail',
      triggerRuleId: 'rule',
      triggerRuleName: 'Email rule',
      eventType: 'email_received',
      triggeredBy: {},
      timestamp: new Date().toISOString(),
      fullContent: {},
    };
    expect(parseTriggerContext(ctx)).toEqual({ ...ctx, autoStart: false });
  });
});

describe('asGmailFullContent', () => {
  it('returns gmail fullContent when source is gmail', () => {
    const ctx = createContext();
    ctx.fullContent = {
      messageId: 'msg-1',
      threadId: 'thread-1',
      from: 'from@example.com',
      to: 'to@example.com',
      subject: 'Subject',
      body: 'Body html',
      bodyPlain: 'Body plain',
      labels: ['INBOX'],
      threadMessageCount: 1,
      hasAttachments: false,
      receivedAt: new Date().toISOString(),
    };
    expect(asGmailFullContent(ctx)).toEqual(ctx.fullContent);
  });

  it('returns null for non-gmail sources', () => {
    const ctx = createContext();
    ctx.source = 'shortcut';
    expect(asGmailFullContent(ctx)).toBeNull();
  });
});

// A flow-webhook context as produced by buildWebhookTriggerContext: envelope + raw payload,
// none of the legacy rule fields. fullContent = the raw provider webhook body.
function webhookContext(fullContent: Record<string, unknown>): Record<string, unknown> {
  return {
    source: 'shortcut',
    sourceAccountId: 'integration-uuid',
    eventType: 'story_update',
    triggeredBy: { externalUserId: 'member-1' },
    timestamp: '2026-06-01T12:00:00.000Z',
    fullContent,
  };
}

describe('parseTriggerContext — flow-webhook shape (no legacy rule fields)', () => {
  it('returns the context (not null) so "View original content" can show', () => {
    const ctx = parseTriggerContext(webhookContext({ primary_id: 7 }) as unknown as TriggerContext);
    expect(ctx).not.toBeNull();
    expect(typeof ctx?.fullContent).toBe('object');
  });
});
// Shortcut raw→rich extraction now lives in buildTriggerSummary (see trigger-summary.test.ts).
