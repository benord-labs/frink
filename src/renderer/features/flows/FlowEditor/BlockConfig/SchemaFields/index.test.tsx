// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SchemaFields } from './index';

// Wiring-level suite: control behavior (typed fields, `{}` template toggle)
// belongs to TemplatableField's own tests; here we assert SchemaFields maps a
// manifest inputs record onto fields with the right identity and routing.
const templatableCalls: Array<Record<string, unknown>> = [];
vi.mock('../TemplatableField', () => ({
  TemplatableField: (
    props: Record<string, unknown> & { renderFixed?: () => import('react').ReactNode },
  ) => {
    templatableCalls.push(props);
    return (
      <div data-testid={`field-${props.fieldId}`}>
        {typeof props.renderFixed === 'function' ? props.renderFixed() : null}
      </div>
    );
  },
}));
const dynamicCalls: Array<Record<string, unknown>> = [];
vi.mock('../CustomNodeConfig/DynamicSelectField', () => ({
  DynamicSelectField: (props: Record<string, unknown>) => {
    dynamicCalls.push(props);
    return <output data-testid={`select-${props.fieldId}`} />;
  },
}));

function renderFields(overrides: Partial<Parameters<typeof SchemaFields>[0]> = {}) {
  templatableCalls.length = 0;
  dynamicCalls.length = 0;
  const onConfigPatch = vi.fn();
  render(
    <SchemaFields
      inputs={{
        channel: {
          type: 'string',
          required: true,
          label: 'Channel',
          description: 'The channel to post in, e.g. #general.',
        },
        count: { type: 'number', default: 3 },
      }}
      values={{ channel: 'general' }}
      fieldIdPrefix="custom-node-n1"
      blockType="my_node"
      credentialsReady={true}
      onConfigPatch={onConfigPatch}
      {...overrides}
    />,
  );
  return { onConfigPatch };
}

describe('SchemaFields', () => {
  it('renders one field per input with node-namespaced ids, values and schema facts', () => {
    renderFields();
    expect(templatableCalls).toHaveLength(2);
    expect(screen.getByTestId('field-custom-node-n1-channel')).toBeInTheDocument();
    const channel = templatableCalls.find((p) => p.fieldId === 'custom-node-n1-channel');
    expect(channel).toMatchObject({
      label: 'Channel',
      type: 'string',
      value: 'general',
      required: true,
      // The provider's own words reach the field, which shows them as help text rather than a placeholder.
      description: 'The channel to post in, e.g. #general.',
    });
    const count = templatableCalls.find((p) => p.fieldId === 'custom-node-n1-count');
    expect(count).toMatchObject({ label: 'count', type: 'number', fallback: 3 });
  });

  it('patches through onConfigPatch keyed by the input name', () => {
    const { onConfigPatch } = renderFields();
    const channel = templatableCalls.find((p) => p.fieldId === 'custom-node-n1-channel');
    (channel?.onChange as (v: unknown) => void)('x');
    expect(onConfigPatch).toHaveBeenCalledWith({ channel: 'x' });
  });

  it('routes listOptions inputs to DynamicSelectField with node context, in fixed mode only', () => {
    renderFields({
      inputs: { board: { type: 'string', listOptions: true, label: 'Board' } },
      values: { board: 'b1' },
      credentialsReady: false,
    });
    expect(dynamicCalls).toHaveLength(1);
    expect(dynamicCalls[0]).toMatchObject({
      fieldId: 'custom-node-n1-board',
      nodeName: 'my_node',
      fieldName: 'board',
      value: 'b1',
      credentialsReady: false,
    });
  });

  it('shows an enum input description as help text beside its select', () => {
    renderFields({
      inputs: {
        visibility: {
          type: 'string',
          options: ['public', 'private'],
          description: 'Who can see the result once the tool has run.',
        },
      },
      values: {},
    });
    expect(screen.getByText('Who can see the result once the tool has run.')).toHaveAttribute(
      'id',
      'custom-node-n1-visibility-hint',
    );
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-describedby',
      'custom-node-n1-visibility-hint',
    );
  });

  it('renders nothing for an empty inputs record', () => {
    renderFields({ inputs: {}, values: {} });
    expect(templatableCalls).toHaveLength(0);
  });
});
