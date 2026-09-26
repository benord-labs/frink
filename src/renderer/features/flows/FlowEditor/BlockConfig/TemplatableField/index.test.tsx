// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import { TemplatableField } from './index';

afterEach(cleanup);

type FieldProps = Parameters<typeof TemplatableField>[0];

/**
 * Stands in for the flow editor, which writes every onChange into node.config and hands the new
 * value straight back as a prop. A non-propagating spy hides mode bugs that only appear once the
 * component sees its own write echoed back, so the harness must round-trip like the real parent.
 */
function ControlledHost({
  initial,
  onChange,
  ...props
}: Partial<FieldProps> & { initial: unknown; onChange: (v: unknown) => void }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <TooltipProvider>
      <TemplatableField
        fieldId="f"
        label="Temperature"
        type="number"
        {...props}
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
      />
    </TooltipProvider>
  );
}

function renderField(over: Partial<FieldProps> = {}) {
  const onChange = vi.fn();
  const tree = (props: Partial<FieldProps>) => (
    <TooltipProvider>
      <TemplatableField
        fieldId="f"
        label="Temperature"
        type="number"
        value={undefined}
        onChange={onChange}
        {...props}
      />
    </TooltipProvider>
  );
  const view = render(tree(over));
  return {
    onChange,
    // Re-renders the SAME instance, mirroring the editor reusing a field across node selections.
    rerender: (next: Partial<FieldProps>) => view.rerender(tree(next)),
  };
}

/** Renders against a parent that echoes writes back, like the real flow editor. */
function renderControlled(over: Partial<FieldProps> & { initial: unknown }) {
  const onChange = vi.fn();
  render(<ControlledHost onChange={onChange} {...over} />);
  return { onChange };
}

describe('TemplatableField', () => {
  it('offers a variable toggle for number and boolean, but not for plain strings', () => {
    renderField({ type: 'number' });
    expect(screen.getByRole('button', { name: 'Use a variable' })).toBeInTheDocument();
    cleanup();

    renderField({ type: 'boolean' });
    expect(screen.getByRole('button', { name: 'Use a variable' })).toBeInTheDocument();
    cleanup();

    // A plain text input already accepts {{...}} inline, so a string needs no mode switch.
    renderField({ type: 'string' });
    expect(screen.queryByRole('button', { name: 'Use a variable' })).not.toBeInTheDocument();
  });

  it('swaps the typed widget for a text input when switching to expression mode', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ type: 'boolean', value: true });

    expect(screen.getByRole('switch')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use a variable' }));

    // A Switch has no text surface — expression mode must replace it, not decorate it.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    // Entering the mode writes nothing; the stored value changes only when a variable is typed.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('starts in expression mode when the saved value already holds a template', () => {
    renderField({ type: 'number', value: '{{previous.temperature}}' });
    expect(screen.getByRole('textbox')).toHaveValue('{{previous.temperature}}');
    expect(screen.getByRole('button', { name: 'Use a fixed value' })).toBeInTheDocument();
  });

  it('rejects mixed interpolation in a typed field at authoring time', async () => {
    renderField({ type: 'number', value: 'v{{previous.count}}' });
    // Coercion to a number cannot survive surrounding text, so it is caught here, not mid-run.
    expect(await screen.findByRole('alert')).toHaveTextContent('exactly one variable');
  });

  it('accepts a single whole placeholder without complaint', () => {
    renderField({ type: 'number', value: '{{previous.count}}' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears a number field to undefined rather than storing a real zero', async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ type: 'number', value: 5 });

    await user.clear(screen.getByRole('spinbutton'));

    // Number('') is 0 and passes Number.isFinite — clearing must mean "unset", not "zero".
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(onChange).not.toHaveBeenCalledWith(0);
  });

  it('returns to the typed widget and drops the template when switching back to fixed', async () => {
    const user = userEvent.setup();
    const { onChange } = renderControlled({ type: 'number', initial: '{{previous.count}}' });

    await user.click(screen.getByRole('button', { name: 'Use a fixed value' }));

    // A field that MOUNTED holding a template has no fixed value behind it, so abandoning clears.
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('keeps expression mode when the template text is cleared for retyping', async () => {
    const user = userEvent.setup();
    renderControlled({ type: 'number', initial: '{{previous.count}}' });

    // Select-all + delete is an ordinary way to start retyping. Deriving mode from the value would
    // eject the field here and start parsing the next keystroke as a number.
    await user.clear(screen.getByRole('textbox'));

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('restores the fixed value when abandoning a half-typed template', async () => {
    const user = userEvent.setup();
    const { onChange } = renderControlled({ type: 'number', initial: 20 });

    await user.click(screen.getByRole('button', { name: 'Use a variable' }));
    await user.type(screen.getByRole('textbox'), '{{prev');
    await user.click(screen.getByRole('button', { name: 'Use a fixed value' }));

    // '{{prev' must not be left in config: it would render a clean 20 here and then fail coercion
    // at dispatch with nothing in the editor explaining why.
    expect(onChange).toHaveBeenLastCalledWith(20);
    expect(screen.getByRole('spinbutton')).toHaveValue(20);
  });

  it('follows the value when it becomes a template outside this control', () => {
    // The flow editor renders one TemplatableField per input NAME, with no key on the node id, so
    // selecting a different custom node with a same-named input reuses this instance. The mode must
    // track the value it is handed, not a stale local flag.
    const { rerender } = renderField({ type: 'number', value: 20 });
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();

    rerender({ type: 'number', value: '{{previous.count}}' });

    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('{{previous.count}}');
  });

  it('re-derives its mode when reused for a different field', async () => {
    const user = userEvent.setup();
    const { rerender } = renderField({ fieldId: 'node-a-temp', type: 'number', value: 20 });

    await user.click(screen.getByRole('button', { name: 'Use a variable' }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    // Selecting another custom node with a same-named input reuses this instance; the fieldId is
    // node-scoped, so the stranded toggle must not carry over to the new field.
    rerender({ fieldId: 'node-b-temp', type: 'number', value: 7 });

    expect(screen.getByRole('spinbutton')).toHaveValue(7);
  });

  it('stays in expression mode against a parent that echoes every write back', async () => {
    // The regression this pins: the toggle used to emit '' and the resulting value-prop change was
    // read as an EXTERNAL edit, resetting the mode in the same pass — so expression mode was
    // unreachable in the real editor while a non-propagating spy made the tests pass.
    const user = userEvent.setup();
    renderControlled({ type: 'number', initial: 20 });

    await user.click(screen.getByRole('button', { name: 'Use a variable' }));

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('does not discard the fixed value merely by switching mode', async () => {
    const user = userEvent.setup();
    const { onChange } = renderControlled({ type: 'number', initial: 20 });

    await user.click(screen.getByRole('button', { name: 'Use a variable' }));
    await user.click(screen.getByRole('button', { name: 'Use a fixed value' }));

    // Toggling out and back must leave the 20 intact — it is only replaced once a variable is typed.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton')).toHaveValue(20);
  });

  it('survives a partially typed template without snapping back to the typed widget', async () => {
    const user = userEvent.setup();
    renderControlled({ type: 'number', initial: 20 });

    await user.click(screen.getByRole('button', { name: 'Use a variable' }));
    // '{{p' is not yet a template; the field must not treat that keystroke as leaving the mode.
    await user.type(screen.getByRole('textbox'), '{{p');

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('renders a json field as a raw textarea with the schema default as its placeholder', async () => {
    const user = userEvent.setup();
    const { onChange } = renderControlled({
      initial: '',
      type: 'json',
      label: 'Filters',
      fallback: { status: 'active' },
      description: 'Narrow the result set.',
    });

    const box = screen.getByRole('textbox', { name: /Filters \(JSON\)/ });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveAttribute('placeholder', JSON.stringify({ status: 'active' }, null, 2));
    expect(screen.getByText('Narrow the result set.')).toBeInTheDocument();
    // Templates go inline, like a text field: no variable toggle.
    expect(screen.queryByRole('button', { name: 'Use a variable' })).not.toBeInTheDocument();

    await user.click(box);
    await user.paste('{{previous.filters}}');
    expect(onChange).toHaveBeenLastCalledWith('{{previous.filters}}');
  });

  it('hints a json field from the placeholder text when the schema carries no description', () => {
    renderField({ type: 'json', label: 'Filters', placeholder: 'Narrow the result set.' });
    expect(screen.getByText('Narrow the result set.')).toHaveAttribute('id', 'f-hint');
  });

  it('shows a description in full under the control, not squeezed into the placeholder', () => {
    const description =
      'Explain why you are calling this tool and how it fits into the wider task you are working on.';
    renderField({ type: 'string', label: 'Context', description });

    const input = screen.getByRole('textbox');
    // A placeholder truncates and vanishes on the first keystroke; the text belongs in the row.
    expect(input).not.toHaveAttribute('placeholder', description);
    expect(screen.getByText(description)).toHaveAttribute('id', 'f-hint');
    expect(input).toHaveAttribute('aria-describedby', 'f-hint');
  });

  it.each([
    ['number', 'spinbutton'],
    ['boolean', 'switch'],
  ])(
    'names the hint from a %s control that shares its row with the variable toggle',
    (type, role) => {
      renderField({ type, description: 'Upper bound on the results returned.' });
      expect(screen.getByRole(role)).toHaveAttribute('aria-describedby', 'f-hint');
      expect(screen.getByText('Upper bound on the results returned.')).toHaveAttribute(
        'id',
        'f-hint',
      );
    },
  );

  it('mounts a custom fixed control only while in fixed mode', async () => {
    const user = userEvent.setup();
    renderField({
      type: 'string',
      renderFixed: () => <div data-testid="picker">picker</div>,
    });

    expect(screen.getByTestId('picker')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use a variable' }));

    // The picker runs the node's --list-options script; it has nothing to resolve against here.
    expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
  });
});
