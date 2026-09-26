// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandOption } from '../../../../lib/commands/types';
import { CommandArgumentsPopover } from './index';

afterEach(cleanup);

const command: SlashCommandOption = {
  id: 'custom:plugin:user:slack:channel-digest',
  name: 'slack:channel-digest',
  command: '/slack:channel-digest',
  description: 'Digest of a channel',
  category: 'repository',
  origin: 'plugin',
  source: 'user',
  takesArguments: true,
  prompt: 'Given the channel names in $ARGUMENTS, summarise $ARGUMENTS.',
};

function renderPopover(overrides: Partial<SlashCommandOption> = {}) {
  const onResolve = vi.fn();
  render(
    <CommandArgumentsPopover
      command={{ ...command, ...overrides }}
      style={{}}
      onResolve={onResolve}
    />,
  );
  return { onResolve, input: screen.getByLabelText('Arguments for /slack:channel-digest') };
}

describe('CommandArgumentsPopover', () => {
  it('fills every $ARGUMENTS with what was typed', () => {
    const { onResolve, input } = renderPopover();
    fireEvent.change(input, { target: { value: '#general' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Given the channel names in #general, summarise #general.',
      }),
    );
  });

  it('backs out on Escape without inserting anything', () => {
    const { onResolve, input } = renderPopover();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('offers the declared argument-hint as the placeholder', () => {
    const { input } = renderPopover({ argumentHint: '[channel names]' });
    expect(input).toHaveAttribute('placeholder', '[channel names]');
  });

  it('falls back to a generic placeholder when the hint is blank', () => {
    const { input } = renderPopover({ argumentHint: '   ' });
    expect(input).toHaveAttribute('placeholder', 'Arguments for this command');
  });

  it('inserts with an empty substitution when submitted with nothing typed', () => {
    const { onResolve, input } = renderPopover();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Given the channel names in , summarise .' }),
    );
  });

  it('puts the caret back where the composer had it before resolving', () => {
    const composer = document.createElement('div');
    composer.contentEditable = 'true';
    composer.textContent = '/slack:channel-digest';
    document.body.appendChild(composer);
    const text = composer.firstChild;
    if (!text) throw new Error('fixture composer should hold a text node');
    const range = document.createRange();
    range.setStart(text, 7);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    const { onResolve, input } = renderPopover();
    fireEvent.keyDown(input, { key: 'Enter' });

    // Restored before onResolve fires, so the editor can still strip its trigger by caret.
    const after = window.getSelection()?.getRangeAt(0);
    expect(after?.startContainer).toBe(text);
    expect(after?.startOffset).toBe(7);
    expect(onResolve).toHaveBeenCalled();
    composer.remove();
  });

  it('confirms on Insert without letting the button take focus off the composer', () => {
    const { onResolve, input } = renderPopover();
    fireEvent.change(input, { target: { value: '#general' } });
    const insert = screen.getByText('Insert');
    const notCancelled = fireEvent.mouseDown(insert);
    // preventDefault means fireEvent reports the event as cancelled.
    expect(notCancelled).toBe(false);
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Given the channel names in #general, summarise #general.',
      }),
    );
  });

  it('dismisses itself when the user clicks away instead of stranding on screen', () => {
    const { onResolve } = renderPopover();
    fireEvent.mouseDown(document.body);
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('stays put for a click inside itself', () => {
    const { onResolve, input } = renderPopover();
    fireEvent.mouseDown(input);
    expect(onResolve).not.toHaveBeenCalled();
  });
});
