// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import { HttpRequestConfig } from './index';

function Harness({ initial }: { initial: Record<string, unknown> }): ReactElement {
  const [config, setConfig] = useState(initial);
  const node: FlowNode = { id: 'http-1', blockType: 'http_request', config };
  return (
    <HttpRequestConfig
      node={node}
      onPatchLabel={() => undefined}
      onConfigPatch={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
    />
  );
}

describe('HttpRequestConfig', () => {
  afterEach(() => {
    cleanup();
  });

  it('preserves body when switching method POST → GET → POST', async () => {
    const user = userEvent.setup();
    const bodyPayload = '{"hello":"world"}';
    render(
      <Harness
        initial={{
          url: 'https://api.example.com',
          method: 'POST',
          body: bodyPayload,
        }}
      />,
    );

    const bodyEl = (): HTMLTextAreaElement =>
      document.getElementById('flow-http-body') as HTMLTextAreaElement;

    expect(bodyEl()).toHaveValue(bodyPayload);

    await user.click(screen.getByRole('combobox', { name: /method/i }));
    await user.click(screen.getByRole('option', { name: 'GET' }));
    expect(bodyEl()).toHaveValue(bodyPayload);

    await user.click(screen.getByRole('combobox', { name: /method/i }));
    await user.click(screen.getByRole('option', { name: 'POST' }));
    expect(bodyEl()).toHaveValue(bodyPayload);
  });
});
