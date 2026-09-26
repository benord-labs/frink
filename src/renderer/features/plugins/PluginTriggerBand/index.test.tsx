// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginTriggerBand } from './index';

afterEach(cleanup);

const TRIGGER_CHAIN: NonNullable<Parameters<typeof PluginTriggerBand>[0]['chain']> = [
  { label: 'Slack', detail: 'New message', caption: 'When this happens', triggerId: 'message' },
  { label: 'Frink', detail: 'runs your Flow', caption: 'Frink does this' },
];

describe('PluginTriggerBand', () => {
  it('states the tools half even for a trigger-less package', () => {
    render(
      <PluginTriggerBand
        pluginName="Toolbox"
        chain={null}
        triggerCount={0}
        agentToolCount={2}
        prompts={['Use tools']}
      />,
    );

    // The summary now lives in the section's accessible name only — the card
    // itself carries no fine print.
    expect(
      screen.getByRole('region', { name: 'What Toolbox can start, 2 tools below' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Frink must be open for triggers to run.')).not.toBeInTheDocument();
  });

  it('joins the trigger sample and the tool count on one summary line', () => {
    render(
      <PluginTriggerBand
        pluginName="Slack"
        chain={[
          {
            label: 'Slack',
            detail: 'mention',
            caption: 'When this happens',
            triggerId: 't1',
          },
          {
            label: 'Frink',
            detail: 'runs your Flow',
            caption: 'Frink does this',
          },
        ]}
        triggerCount={4}
        agentToolCount={1}
      />,
    );

    expect(
      screen.getByRole('region', {
        name: 'What Slack can start, 1 of 4 triggers · 1 tool below',
      }),
    ).toBeInTheDocument();
    // The runtime notice is page fine print now, never card copy.
    expect(screen.queryByText('Frink must be open for triggers to run.')).not.toBeInTheDocument();
  });

  it('pages to a prompt slide and hands back the clicked prompt', () => {
    const onUsePrompt = vi.fn();
    render(
      <PluginTriggerBand
        pluginName="Slack"
        chain={TRIGGER_CHAIN}
        triggerCount={0}
        agentToolCount={1}
        prompts={['Catch me up on Slack']}
        onUsePrompt={onUsePrompt}
      />,
    );

    // The flow slide leads; the prompt lives one slide over and is inert until shown.
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 2 of 2' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Use this prompt in chat: Catch me up on Slack',
      }),
    );
    expect(onUsePrompt).toHaveBeenCalledWith('Catch me up on Slack');
  });

  it('labels locked prompts as Connect-first so nothing over-promises', () => {
    const onUsePrompt = vi.fn();
    render(
      <PluginTriggerBand
        pluginName="ClickUp"
        chain={TRIGGER_CHAIN}
        triggerCount={0}
        agentToolCount={1}
        prompts={['What is overdue in ClickUp this week?']}
        onUsePrompt={onUsePrompt}
        promptsLocked
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show slide 2 of 2' }));
    expect(screen.getByText('Connect ClickUp to try this in chat')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Connect ClickUp to use this prompt in chat: What is overdue in ClickUp this week?',
      }),
    );
    expect(onUsePrompt).toHaveBeenCalledWith('What is overdue in ClickUp this week?');
  });

  it('wraps around: Next past the last slide returns to the first, Previous mirrors it', () => {
    render(
      <PluginTriggerBand
        pluginName="Slack"
        chain={TRIGGER_CHAIN}
        triggerCount={0}
        agentToolCount={1}
        prompts={['Catch me up on Slack', 'Summarize #general']}
        onUsePrompt={() => {}}
      />,
    );

    const next = screen.getByRole('button', { name: 'Next slide' });
    const previous = screen.getByRole('button', { name: 'Previous slide' });

    fireEvent.click(next);
    expect(
      screen.getByRole('button', {
        name: 'Use this prompt in chat: Catch me up on Slack',
      }),
    ).toBeInTheDocument();
    fireEvent.click(next);
    expect(
      screen.getByRole('button', {
        name: 'Use this prompt in chat: Summarize #general',
      }),
    ).toBeInTheDocument();
    // Past the end: back to the flow slide, whose text is visible again.
    fireEvent.click(next);
    expect(screen.getByText('· New message')).toBeVisible();

    // Previous from the first slide lands on the last prompt.
    fireEvent.click(previous);
    expect(
      screen.getByRole('button', {
        name: 'Use this prompt in chat: Summarize #general',
      }),
    ).toBeInTheDocument();
  });

  it('keeps navigating after the slide list shrinks below the active index', () => {
    const props = {
      pluginName: 'Slack',
      chain: TRIGGER_CHAIN,
      triggerCount: 0,
      agentToolCount: 1,
      onUsePrompt: () => {},
    };
    const { rerender } = render(
      <PluginTriggerBand
        {...props}
        prompts={['Catch me up on Slack', 'Summarize #general', 'Draft a standup update']}
      />,
    );
    // Land on the last slide, then shrink the list beneath it.
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 4 of 4' }));
    rerender(<PluginTriggerBand {...props} prompts={['Catch me up on Slack']} />);

    // Clamped to the last remaining slide; Next must still advance, not recompute the same slide.
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByText('· New message')).toBeVisible();
  });

  it('counts every click when rapid Next clicks land in one render batch', () => {
    render(
      <PluginTriggerBand
        pluginName="Slack"
        chain={TRIGGER_CHAIN}
        triggerCount={0}
        agentToolCount={1}
        prompts={['Catch me up on Slack', 'Summarize #general']}
        onUsePrompt={() => {}}
      />,
    );
    const next = screen.getByRole('button', { name: 'Next slide' });

    act(() => {
      next.click();
      next.click();
    });

    expect(
      screen.getByRole('button', {
        name: 'Use this prompt in chat: Summarize #general',
      }),
    ).toBeInTheDocument();
  });

  it('keeps examples browsable when connecting or turned off removes their action handler', () => {
    const props = {
      pluginName: 'ClickUp',
      chain: TRIGGER_CHAIN,
      triggerCount: 0,
      prompts: ['Plan my sprint'],
    };
    const { rerender } = render(<PluginTriggerBand {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByRole('button', { name: 'Example prompt: Plan my sprint' })).toBeDisabled();

    rerender(<PluginTriggerBand {...props} onUsePrompt={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Use this prompt in chat: Plan my sprint' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Show slide 2 of 2' })).toBeInTheDocument();
  });

  it('offers no pager or prompt slides without prompts', () => {
    render(
      <PluginTriggerBand
        pluginName="Slack"
        chain={TRIGGER_CHAIN}
        triggerCount={0}
        agentToolCount={1}
        prompts={[]}
        onUsePrompt={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: /slide/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Use this prompt in chat/ }),
    ).not.toBeInTheDocument();
  });

  it('says tools reach chats only for a package that ships an MCP', () => {
    render(
      <PluginTriggerBand
        pluginName="Shortcut"
        prompts={['Use tools']}
        chain={null}
        triggerCount={0}
        agentToolCount={3}
        chatToolsAvailable
      />,
    );

    expect(
      screen.getByRole('region', {
        name: 'What Shortcut can start, 3 tools below · tools work in chats too',
      }),
    ).toBeInTheDocument();
  });
  it('omits an empty carousel instead of inventing a trigger slide', () => {
    render(<PluginTriggerBand pluginName="Empty" chain={null} triggerCount={0} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('puts the pager and prompt buttons on the glass, so Transparency reaches them', () => {
    render(
      <PluginTriggerBand
        pluginName="Slack"
        chain={null}
        triggerCount={0}
        prompts={['Catch me up', 'Summarise the channel']}
        onUsePrompt={() => {}}
      />,
    );
    for (const name of ['Previous slide', 'Next slide', 'Use this prompt in chat: Catch me up'])
      expect(screen.getByRole('button', { name })).toHaveClass('glass-card');
  });

  it.each([true, false])('caps slides at five with a trigger: %s', (withTrigger) => {
    const prompts = [
      'Flow action',
      'First skill',
      'Second skill',
      'Third skill',
      'Fourth skill',
      'Extra',
    ];
    render(
      <PluginTriggerBand
        pluginName="Examples"
        chain={withTrigger ? TRIGGER_CHAIN : null}
        triggerCount={withTrigger ? 1 : 0}
        prompts={prompts}
        onUsePrompt={() => {}}
      />,
    );
    expect(screen.getAllByRole('button', { name: /Show slide/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: `Show slide ${withTrigger ? 2 : 1} of 5` }));
    expect(
      screen.getByRole('button', { name: 'Use this prompt in chat: Flow action' }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 5 of 5' }));
    expect(
      screen.getByRole('button', {
        name: `Use this prompt in chat: ${withTrigger ? 'Third skill' : 'Fourth skill'}`,
      }),
    ).toBeVisible();
    expect(screen.queryByText('“Extra”')).not.toBeInTheDocument();
  });
});
