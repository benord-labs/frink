// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriggerContext } from '../../../../../../shared/types/trigger-context';
import { TriggerContentDialog } from './index';

afterEach(() => {
  cleanup();
});

function makeContext(
  source: TriggerContext['source'],
  fullContent: Record<string, unknown>,
): TriggerContext {
  return {
    source,
    sourceAccountId: 'acc',
    eventType: 'event',
    triggeredBy: { name: 'Tester' },
    timestamp: '2026-03-03T10:00:00.000Z',
    autoStart: false,
    fullContent,
  } as TriggerContext;
}

describe('TriggerContentDialog', () => {
  it('renders a structured shortcut summary from the RAW webhook body', () => {
    const ctx = makeContext('shortcut', {
      primary_id: 123,
      actions: [
        {
          entity_type: 'story',
          name: 'Add queue modal',
          story_type: 'feature',
          app_url: 'https://app.shortcut.com/owners-web/story/123',
          workflow_state_id: 500,
          project_id: 311,
          description: 'Wire up the new queue dialog UI.\n\n```ts\nconst taskId = "123";\n```',
        },
      ],
      references: [
        { id: 500, entity_type: 'workflow-state', name: 'Backlog', type: 'unstarted' },
        { id: 311, entity_type: 'project', name: 'owners-web' },
      ],
    });

    render(<TriggerContentDialog open onOpenChange={vi.fn()} triggerContext={ctx} />);

    expect(screen.getByText('Original Shortcut Trigger')).toBeInTheDocument();
    expect(screen.getByText('Add queue modal')).toBeInTheDocument();
    expect(screen.getByText('#123')).toBeInTheDocument();
    expect(screen.getByText('owners-web')).toBeInTheDocument();
    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByText(/const taskId = "123";/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Summary/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Raw payload/i })).toBeInTheDocument();
    // Story-ID link uses the validated app_url (accessible name includes an sr-only new-tab cue).
    expect(screen.getByRole('link', { name: /#123/ })).toHaveAttribute(
      'href',
      'https://app.shortcut.com/owners-web/story/123',
    );
  });

  it('still renders (provider title) for a payload with no recognisable fields', () => {
    const ctx = makeContext('shortcut', { someRandomKey: 42 });
    render(<TriggerContentDialog open onOpenChange={vi.fn()} triggerContext={ctx} />);
    expect(screen.getByText('Original Shortcut Trigger')).toBeInTheDocument();
    // Title falls back to the provider name; the raw key lives on the Raw payload tab.
    expect(screen.getByText('Shortcut')).toBeInTheDocument();
  });

  it('renders a linear issue title, priority and link from the raw body', () => {
    const ctx = makeContext('linear', {
      action: 'create',
      url: 'https://linear.app/acme/issue/ENG-42',
      data: { title: 'Burst traffic bug', identifier: 'ENG-42', priorityLabel: 'High' },
    });
    render(<TriggerContentDialog open onOpenChange={vi.fn()} triggerContext={ctx} />);
    expect(screen.getByText('Original Linear Trigger')).toBeInTheDocument();
    expect(screen.getByText('Burst traffic bug')).toBeInTheDocument();
    expect(screen.getByText('ENG-42')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('omits the link when the URL origin mismatches the provider web_domain', () => {
    const ctx = makeContext('linear', {
      data: { identifier: 'ENG-99', title: 'X' },
      url: 'https://attacker.example/evil',
    });
    render(<TriggerContentDialog open onOpenChange={vi.fn()} triggerContext={ctx} />);
    // The identifier renders, but NOT as a link (origin mismatch).
    expect(screen.queryByRole('link', { name: /ENG-99/ })).toBeNull();
  });
});
