// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../../components/ui/tooltip';
import type { PluginTool } from '../ToolPickerField';
// SchemaFields reaches the tRPC client through DynamicSelectField; no projected input ever lists options.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../../../lib/trpc', () => ({ trpc: {} }));

const { CallToolArguments } = await import('./index');

afterEach(cleanup);

const tool: PluginTool = {
  name: 'error-tracking-list',
  title: 'List errors',
  readOnly: true,
  destructive: false,
  inputs: {
    limit: { type: 'number', required: true },
    status: { type: 'string' },
    filters: { type: 'json' },
  },
  unsupportedFields: ['orderBy'],
};

/** `null` renders without a tool row (an explicit `undefined` would take the default). */
type StoredArguments = string | Record<string, string | number> | undefined;

function renderArgs(value: StoredArguments, row: PluginTool | null = tool) {
  const onConfigPatch = vi.fn();
  render(
    <TooltipProvider>
      <CallToolArguments
        nodeId="n1"
        blockType="posthog_call_tool"
        tool={row ?? undefined}
        value={value}
        onConfigPatch={onConfigPatch}
      />
    </TooltipProvider>,
  );
  return onConfigPatch;
}

describe('CallToolArguments', () => {
  it('renders the picked tool as fields by default and writes typed values into the arguments object', async () => {
    const user = userEvent.setup();
    const patch = renderArgs({ status: 'active' });

    expect(screen.getByText(/needs a value for: limit\./)).toBeInTheDocument();
    expect(screen.getByText(/Not editable as fields: orderBy\./)).toBeInTheDocument();
    await user.type(screen.getByRole('spinbutton', { name: 'limit' }), '5');
    expect(patch).toHaveBeenLastCalledWith({ arguments: { status: 'active', limit: 5 } });
  });

  it('clears a field when the form unsets it, so a number can be emptied and a variable abandoned', async () => {
    const user = userEvent.setup();
    const patch = renderArgs({ status: 'active', limit: 5 });

    await user.clear(screen.getByRole('spinbutton', { name: 'limit' }));
    expect(patch).toHaveBeenLastCalledWith({ arguments: { status: 'active' } });
  });

  it('forgets a JSON draft on a mode switch so the stored value shows after the round trip', async () => {
    const user = userEvent.setup();
    const patch = renderArgs({});

    await user.type(screen.getByRole('textbox', { name: /filters \(JSON\)/ }), '{{');
    await user.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    expect(patch).toHaveBeenLastCalledWith({ arguments: '{}' });
  });

  it('keeps a JSON sub-field as a draft until it parses, then stores the object', async () => {
    const user = userEvent.setup();
    const patch = renderArgs({});
    const field = screen.getByRole('textbox', { name: /filters \(JSON\)/ });

    await user.type(field, '{{');
    expect(patch).not.toHaveBeenCalled();
    await user.clear(field);
    await user.type(field, '{{"from": "-7d"}');
    expect(patch).toHaveBeenLastCalledWith({ arguments: { filters: { from: '-7d' } } });
  });

  it('switches to JSON text and back, refusing the way back until the text is an object', async () => {
    const user = userEvent.setup();
    const patch = renderArgs({ limit: 5 });

    await user.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    expect(patch).toHaveBeenLastCalledWith({ arguments: '{\n  "limit": 5\n}' });
    cleanup();

    renderArgs('[1, 2]');
    expect(screen.getByRole('textbox', { name: /Arguments \(JSON\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit as fields' })).toBeDisabled();
    cleanup();

    const back = renderArgs('{"limit": 5}');
    await user.click(screen.getByRole('button', { name: 'Edit as fields' }));
    expect(back).toHaveBeenLastCalledWith({ arguments: { limit: 5 } });
    cleanup();

    // Blanked text is "no arguments", never a dead end.
    const blank = renderArgs('');
    await user.click(screen.getByRole('button', { name: 'Edit as fields' }));
    expect(blank).toHaveBeenLastCalledWith({ arguments: {} });
  });

  it('falls back to JSON text with no toggle when the tool row is unavailable, and renders nothing before a pick', () => {
    renderArgs({ limit: 5 }, null);
    expect(screen.getByRole('textbox', { name: /Arguments \(JSON\)/ })).toHaveValue(
      '{\n  "limit": 5\n}',
    );
    expect(screen.queryByRole('button', { name: /Edit as/ })).toBeNull();
    expect(screen.getByText(/tool list is unavailable/)).toBeInTheDocument();
    cleanup();

    const { container } = render(
      <TooltipProvider>
        <CallToolArguments
          nodeId="n1"
          blockType="posthog_call_tool"
          tool={undefined}
          value={undefined}
          onConfigPatch={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
