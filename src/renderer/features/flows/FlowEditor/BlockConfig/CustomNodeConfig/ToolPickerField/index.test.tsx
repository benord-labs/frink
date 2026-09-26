// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginTool, PluginToolsState } from './index';

const openSettingsTab = vi.hoisted(() => vi.fn());
// The hook writes jotai atoms that open the Settings dialog; the click is the contract under test.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../../../hooks/useSettingsNavigation', () => ({
  useSettingsNavigation: () => ({ openSettings: vi.fn(), openSettingsTab }),
}));
// happy-dom has no layout, so the virtualizer would render nothing; rows map 1:1 instead.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: String(index), size: 44, start: index * 44 })),
    getTotalSize: () => count * 44,
    measure: vi.fn(),
  }),
}));
// Radix portals the list only once opened; rendering it inline keeps the rows queryable.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../../../components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { ToolPickerField } = await import('./index');

afterEach(cleanup);

function tool(name: string, extra: Partial<PluginTool> = {}): PluginTool {
  return { name, readOnly: false, destructive: false, inputs: {}, unsupportedFields: [], ...extra };
}

const many: PluginTool[] = Array.from({ length: 1000 }, (_, i) => tool(`tool-${i}`));

function renderPicker(tools: PluginToolsState, value = '') {
  const onChange = vi.fn();
  render(<ToolPickerField fieldId="f" value={value} tools={tools} onChange={onChange} />);
  return onChange;
}

describe('ToolPickerField', () => {
  it('lists every tool read-only first, filters by search, and picks by name', async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({
      ok: true,
      tools: [
        tool('wipe-project', { title: 'Wipe project', destructive: true }),
        tool('error-tracking-list', { title: 'List errors', readOnly: true, description: 'Newest first.' }),
        ...many,
      ],
    });

    // The field label names the trigger; its text is the current pick.
    expect(screen.getByRole('button', { name: 'Tool' })).toHaveTextContent('Choose a tool…');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1002);
    expect(options[0]).toHaveAccessibleName('List errors');
    expect(screen.getByText('changes data')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Search tools' }), 'newest');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.click(screen.getByRole('option', { name: 'List errors' }));
    expect(onChange).toHaveBeenCalledWith('error-tracking-list');
  });

  it('does not report a change when the current tool is picked again', async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({ ok: true, tools: [tool('a', { title: 'Tool A' })] }, 'a');
    await user.click(screen.getByRole('option', { name: 'Tool A' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the picked tool and its description, and says when the server no longer offers it', () => {
    renderPicker(
      { ok: true, tools: [tool('a', { title: 'Tool A', description: 'Does A.' })] },
      'a',
    );
    expect(screen.getByRole('button', { name: 'Tool' })).toHaveTextContent('Tool A');
    // The hint under the trigger, apart from the same text inside the (always-open, mocked) list.
    expect(document.getElementById('f-hint')).toHaveTextContent('Does A.');
    cleanup();

    renderPicker({ ok: true, tools: [] }, 'gone');
    expect(screen.getByText(/no longer offered by the server/)).toBeInTheDocument();
    cleanup();

    // A picked tool that simply has no description is not a missing one.
    renderPicker({ ok: true, tools: [tool('bare')] }, 'bare');
    expect(screen.queryByText(/no longer offered/)).toBeNull();
  });

  it('replaces the picker with the reason and a Settings button when the server cannot be read', async () => {
    const user = userEvent.setup();
    renderPicker({ ok: false, reason: 'posthog is not connected — connect an account.' });

    expect(screen.getByText('posthog is not connected — connect an account.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open Settings → Plugins' }));
    expect(openSettingsTab).toHaveBeenCalledWith('integrations');
  });

  it('disables the trigger while the list loads', () => {
    renderPicker(undefined);
    const trigger = screen.getByRole('button', { name: 'Tool' });
    expect(trigger).toHaveTextContent('Loading tools…');
    expect(trigger).toBeDisabled();
  });
});
