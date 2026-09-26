// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddAccountForm } from './index';

function renderForm() {
  const onAddWithToken = vi.fn();
  const onAddWithApiKey = vi.fn();
  render(
    <AddAccountForm
      defaultName="Claude API key 2"
      onAddWithToken={onAddWithToken}
      onAddWithApiKey={onAddWithApiKey}
      onCancel={vi.fn()}
    />,
  );
  return { onAddWithToken, onAddWithApiKey };
}

afterEach(cleanup);

describe('AddAccountForm', () => {
  it('focuses the key field and names a blank-named key after the default', async () => {
    const { onAddWithApiKey } = renderForm();
    const key = screen.getByLabelText('API key');
    expect(key).toHaveFocus();

    await userEvent.type(key, 'sk-ant-api03-abc');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(onAddWithApiKey).toHaveBeenCalledWith('Claude API key 2', 'sk-ant-api03-abc');
    expect(key).toHaveValue('');
  });

  it('sends a Claude sign-in token down the token path, under the typed name', async () => {
    const { onAddWithToken, onAddWithApiKey } = renderForm();
    await userEvent.type(screen.getByLabelText('API key'), 'sk-ant-oat01-abc');
    await userEvent.type(screen.getByLabelText('Account name'), 'Work');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(onAddWithToken).toHaveBeenCalledWith('Work', 'sk-ant-oat01-abc');
    expect(onAddWithApiKey).not.toHaveBeenCalled();
  });
});
