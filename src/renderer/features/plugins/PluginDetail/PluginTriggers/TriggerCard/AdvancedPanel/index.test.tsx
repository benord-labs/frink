// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getProviderById } from '../../../../../../../shared/integrations/selectors';
import { AdvancedPanel, EndpointSecret } from './index';

vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

it('names the address and secret controls before reveal, after reveal, and after hiding again', () => {
  const provider = getProviderById('shortcut');
  if (!provider) throw new Error('Shortcut provider is required for this test');
  const secret = 'ab'.repeat(32);
  render(
    <AdvancedPanel
      provider={provider}
      endpoint={{
        id: 'endpoint-1',
        webhookUrl: 'https://frink.example.com/api/triggers/shortcut/token-1',
        webhookSecret: secret,
        vendorRef: 'hook-1',
        isActive: true,
        lastReceivedAt: null,
        lastError: null,
      }}
      withManualSetup={false}
      rotating={false}
      deactivating={false}
      onRotate={vi.fn()}
      onDeactivate={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Advanced/ }));

  expect(screen.getByRole('textbox', { name: 'Webhook address' })).toHaveValue(
    'https://frink.example.com/api/triggers/shortcut/token-1',
  );
  expect(screen.getByRole('button', { name: 'Copy Webhook address' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Secret, hidden' })).not.toHaveValue(secret);

  fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
  expect(screen.getByRole('textbox', { name: 'Secret' })).toHaveValue(secret);
  expect(screen.getByRole('button', { name: 'Copy Secret' })).toBeInTheDocument();
  expect(screen.getAllByText('Secret')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  expect(screen.getByRole('textbox', { name: 'Secret, hidden' })).not.toHaveValue(secret);
  expect(screen.queryByRole('button', { name: 'Copy Secret' })).not.toBeInTheDocument();
});

it('masks the hidden secret at a fixed width regardless of the secret length', () => {
  const { unmount } = render(<EndpointSecret secret={'a'.repeat(20)} />);
  const shortMask = screen.getByRole('textbox', { name: 'Secret, hidden' });
  expect(shortMask).toHaveValue('*'.repeat(12));
  unmount();

  render(<EndpointSecret secret={'b'.repeat(64)} />);
  const longMask = screen.getByRole('textbox', { name: 'Secret, hidden' });
  expect(longMask).toHaveValue('*'.repeat(12));
});
