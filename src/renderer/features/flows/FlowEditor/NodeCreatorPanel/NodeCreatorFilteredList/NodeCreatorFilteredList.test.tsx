// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowBlockType } from '../../../../../../shared/types/flow';
import { NodeCreatorFilteredList } from '.';

describe('NodeCreatorFilteredList', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not mark active or sync hover index when block type is missing from blockTypeIndexMap', () => {
    const onActiveIndexChange = vi.fn();
    const onPick = vi.fn();
    render(
      <NodeCreatorFilteredList
        filtered={[{ id: 'cat', label: 'Category', types: ['agent' as FlowBlockType] }]}
        blockTypeIndexMap={new Map<FlowBlockType, number>([['manual_trigger', 0]])}
        activeIndex={0}
        onActiveIndexChange={onActiveIndexChange}
        onPick={onPick}
      />,
    );

    const option = screen.getByRole('option');
    expect(option).toHaveAttribute('aria-selected', 'false');
    expect(option.id).toBe('node-creator-option-unknown-agent');

    fireEvent.mouseEnter(option);
    expect(onActiveIndexChange).not.toHaveBeenCalled();
  });

  it('marks selected when mapped index matches activeIndex', () => {
    render(
      <NodeCreatorFilteredList
        filtered={[{ id: 'cat', label: 'Category', types: ['agent' as FlowBlockType] }]}
        blockTypeIndexMap={new Map<FlowBlockType, number>([['agent', 0]])}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    const option = screen.getByRole('option');
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(option.id).toBe('node-creator-option-0');
  });

  it('renders a non-tabbable option without nested controls and picks it on click', () => {
    const onPick = vi.fn();
    render(
      <NodeCreatorFilteredList
        filtered={[{ id: 'custom', label: 'Custom', types: ['my_node' as FlowBlockType] }]}
        blockTypeIndexMap={new Map<string, number>([['my_node', 0]])}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onPick={onPick}
        customLabels={new Map([['my_node', 'My Node']])}
        customDescriptions={new Map([['my_node', 'Desc']])}
      />,
    );

    const option = screen.getByRole('option', { name: /my node/i });
    expect(option).toHaveAttribute('tabindex', '-1');
    expect(option.querySelector('button')).toBeNull();
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith('my_node');
  });

  it('exposes each plugin as a labelled group within Integrations without changing option order', () => {
    render(
      <NodeCreatorFilteredList
        filtered={[
          {
            id: 'integrations',
            label: 'Integrations',
            types: [
              'slack_send_message',
              'slack_list_channels',
              'shortcut_create_story',
            ] as unknown as FlowBlockType[],
          },
        ]}
        blockTypeIndexMap={
          new Map<string, number>([
            ['slack_send_message', 0],
            ['slack_list_channels', 1],
            ['shortcut_create_story', 2],
          ])
        }
        activeIndex={1}
        onActiveIndexChange={vi.fn()}
        onPick={vi.fn()}
        customLabels={
          new Map([
            ['slack_send_message', 'Send Slack message'],
            ['slack_list_channels', 'List Slack channels'],
            ['shortcut_create_story', 'Create Shortcut story'],
          ])
        }
        pluginMeta={
          new Map([
            ['slack_send_message', { pluginId: 'slack', pluginLabel: 'Slack' }],
            ['slack_list_channels', { pluginId: 'slack', pluginLabel: 'Slack' }],
            ['shortcut_create_story', { pluginId: 'shortcut', pluginLabel: 'Shortcut' }],
          ])
        }
      />,
    );

    const integrationsGroup = screen.getByRole('group', { name: 'Integrations' });
    const slackGroup = within(integrationsGroup).getByRole('group', { name: 'Slack' });
    const shortcutGroup = within(integrationsGroup).getByRole('group', { name: 'Shortcut' });
    expect(within(slackGroup).getAllByRole('option')).toHaveLength(2);
    expect(within(shortcutGroup).getAllByRole('option')).toHaveLength(1);
    expect(within(slackGroup).queryByRole('option', { name: /Shortcut/ })).toBeNull();
    expect(
      within(shortcutGroup).getByRole('option', { name: 'Create Shortcut story' }),
    ).toBeInTheDocument();
    expect(integrationsGroup).toContainElement(screen.getByText('Slack'));
    expect(integrationsGroup).toContainElement(screen.getByText('2 tools'));
    expect(integrationsGroup).toContainElement(screen.getByText('Shortcut'));
    expect(integrationsGroup).toContainElement(screen.getByText('1 tool'));

    // Keyboard flattening order == render order: option ids follow cat.types.
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.id)).toEqual([
      'node-creator-option-0',
      'node-creator-option-1',
      'node-creator-option-2',
    ]);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lands a node with no plugin meta in a generic Integrations run', () => {
    render(
      <NodeCreatorFilteredList
        filtered={[
          {
            id: 'integrations',
            label: 'Integrations',
            types: ['mystery_node'] as unknown as FlowBlockType[],
          },
        ]}
        blockTypeIndexMap={new Map<string, number>([['mystery_node', 0]])}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    expect(screen.getByRole('option').closest('[role=group]')).toHaveAccessibleName('Integrations');
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  it('renders each integration row with its declared icon, never the custom-node fallback', () => {
    render(
      <NodeCreatorFilteredList
        filtered={[
          {
            id: 'integrations',
            label: 'Integrations',
            types: ['slack_send_message'] as unknown as FlowBlockType[],
          },
        ]}
        blockTypeIndexMap={new Map<string, number>([['slack_send_message', 0]])}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onPick={vi.fn()}
        customLabels={new Map([['slack_send_message', 'Send Slack message']])}
        customBlockIcons={new Map([['slack_send_message', 'send']])}
        customDescriptions={
          new Map([['slack_send_message', 'Flow step that posts a message to a channel.']])
        }
        pluginMeta={new Map([['slack_send_message', { pluginId: 'slack', pluginLabel: 'Slack' }]])}
      />,
    );

    const row = screen.getByRole('option');
    expect(row.querySelector('.lucide-send')).not.toBeNull();
    expect(row.querySelector('.lucide-bot')).toBeNull();
    expect(screen.getByText('Flow step that posts a message to a channel.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
