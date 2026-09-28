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
// happy-dom has no layout, so the real virtualizer would render nothing. Like the real one, this
// mounts a fixed window of rows and records the full count it was handed.
const virtualizer = vi.hoisted(() => ({ window: 20, count: 0 }));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualizer.count = count;
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.min(count, virtualizer.window) }, (_, index) => ({
          index,
          key: String(index),
          size: 44,
          start: index * 44,
        })),
      getTotalSize: () => count * 44,
      measure: vi.fn(),
    };
  },
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
        tool('delete-project', { title: 'Delete project', destructive: true }),
        tool('error-tracking-list', {
          title: 'List errors',
          readOnly: true,
          description: 'Newest first.',
        }),
        ...many,
      ],
    });

    // The field label names the trigger; its text is the current pick.
    expect(screen.getByRole('button', { name: 'Tool' })).toHaveTextContent('Choose a tool…');
    // Every tool reaches the list; only the window mounts.
    expect(virtualizer.count).toBe(1002);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(20);
    expect(options[0]).toHaveAccessibleName('List errors');
    expect(screen.getByText('changes data')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Search tools' }), 'newest');
    expect(virtualizer.count).toBe(1);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.click(screen.getByRole('option', { name: 'List errors' }));
    expect(onChange).toHaveBeenCalledWith('error-tracking-list');
  });

  it('matches a search typed loosely or by the raw tool name, and says when nothing matches', async () => {
    const user = userEvent.setup();
    renderPicker({
      ok: true,
      tools: [
        tool('error-tracking-list', {
          title: 'List errors',
          readOnly: true,
          description: 'Newest first.',
        }),
        tool('a'),
        tool('b'),
      ],
    });
    const search = screen.getByRole('textbox', { name: 'Search tools' });
    expect(search).toHaveAttribute('placeholder', 'Search 3 tools…');

    // Surrounding spaces and capitals are what people paste and type.
    await user.type(search, '  NEWEST  ');
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
      'List errors',
    ]);

    // The name is searchable even when a title replaces it on screen.
    await user.clear(search);
    await user.type(search, 'error-tracking');
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
      'List errors',
    ]);

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText('No tools match.')).toBeInTheDocument();
  });

  it('clears the search after a pick so the next open lists every tool again', async () => {
    const user = userEvent.setup();
    renderPicker({
      ok: true,
      tools: [
        tool('a', { title: 'Tool A' }),
        tool('b', { title: 'Tool B' }),
        tool('c', { title: 'Tool C' }),
      ],
    });
    const search = screen.getByRole('textbox', { name: 'Search tools' });
    await user.type(search, 'tool b');
    expect(virtualizer.count).toBe(1);

    await user.click(screen.getByRole('option', { name: 'Tool B' }));
    expect(search).toHaveValue('');
    expect(virtualizer.count).toBe(3);
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
