// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriggerContext } from '../../../../../../shared/types/trigger-context';
import { EmailTriggerContentDialog } from './index';

const RENDERED_TAB_REGEX = /Rendered/i;
const PLAIN_TEXT_TAB_REGEX = /Plain text/i;
const RENDERED_EMAIL_REGEX = /Rendered email/i;
const PLAIN_BODY_REGEX = /No html in this email body/;

afterEach(() => {
  cleanup();
});

function createGmailContext(): TriggerContext {
  return {
    source: 'gmail',
    sourceAccountId: 'acc',
    sourceAccountName: 'Gmail Work',
    triggerRuleId: 'rule-1',
    triggerRuleName: 'Important email',
    eventType: 'email_received',
    triggeredBy: {},
    timestamp: '2026-03-03T10:00:00.000Z',
    autoStart: false,
    fullContent: {
      messageId: 'msg-1',
      threadId: 'thread-1',
      from: 'Alex <alex@example.com>',
      to: 'Benji <benji@example.com>',
      subject: 'Sprint update',
      body: '<p>HTML body</p>',
      bodyPlain: 'Plain body line 1\nPlain body line 2',
      labels: ['INBOX', 'IMPORTANT'],
      threadMessageCount: 4,
      hasAttachments: true,
      receivedAt: '2026-03-03T09:58:00.000Z',
      snippet: 'Plain body line 1',
    },
  };
}

describe('EmailTriggerContentDialog', () => {
  it('renders full Gmail metadata and plain body', () => {
    render(
      <EmailTriggerContentDialog
        open
        onOpenChange={vi.fn()}
        triggerContext={createGmailContext()}
      />,
    );

    expect(screen.getByText('Original Email')).toBeInTheDocument();
    expect(screen.getByText('Alex <alex@example.com>')).toBeInTheDocument();
    expect(screen.getByText('Sprint update')).toBeInTheDocument();
    expect(screen.getByText('INBOX, IMPORTANT')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: RENDERED_TAB_REGEX })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: PLAIN_TEXT_TAB_REGEX })).toBeInTheDocument();
    expect(screen.getByTitle(RENDERED_EMAIL_REGEX)).toBeInTheDocument();
  });

  it('renders readable plain body when html markup is absent', () => {
    const baseContext = createGmailContext();
    const context = {
      ...baseContext,
      fullContent: {
        ...baseContext.fullContent,
        body: 'No html in this email body',
        bodyPlain: '',
      },
    };

    render(<EmailTriggerContentDialog open onOpenChange={vi.fn()} triggerContext={context} />);

    expect(screen.queryByRole('tab', { name: RENDERED_TAB_REGEX })).not.toBeInTheDocument();
    expect(screen.getByText(PLAIN_BODY_REGEX)).toBeInTheDocument();
  });

  // Inbound email HTML is attacker-controlled. The iframe is sandboxed as well; the sanitiser is
  // the layer that must still hold if that attribute is ever loosened.
  it('sanitises hostile email html before it reaches the rendered frame', () => {
    const baseContext = createGmailContext();
    const context = {
      ...baseContext,
      fullContent: {
        ...baseContext.fullContent,
        body:
          '<p>Hello <b>team</b></p><script>alert(1)</script><img src=x onerror="alert(2)">' +
          '<a href="javascript:alert(3)">click</a><iframe src="https://evil.example"></iframe>',
      },
    };

    render(<EmailTriggerContentDialog open onOpenChange={vi.fn()} triggerContext={context} />);

    const frame = screen.getByTitle(RENDERED_EMAIL_REGEX);
    const srcDoc = frame.getAttribute('srcdoc') ?? '';
    expect(frame).toHaveAttribute('sandbox', '');
    expect(srcDoc).toContain('<p>Hello <b>team</b></p>');
    expect(srcDoc).not.toMatch(/<script|onerror|javascript:|evil\.example/i);
  });
});
