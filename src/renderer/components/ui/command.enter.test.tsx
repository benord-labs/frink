// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command, CommandItem, CommandList } from './command';

afterEach(cleanup);

describe('CommandItem — Enter on a focused item', () => {
  it('selects the item once', () => {
    const onOpenFolder = vi.fn();
    render(
      <Command>
        <CommandList>
          <CommandItem value="open-folder" onSelect={onOpenFolder}>
            Open a folder
          </CommandItem>
        </CommandList>
      </Command>,
    );

    // The selected item is the one tab stop (tabIndex 0), so Tab from the search input lands on it.
    const item = screen.getByRole('menuitem', { name: 'Open a folder' });
    expect(item).toHaveAttribute('tabindex', '0');
    item.focus();
    fireEvent.keyDown(item, { key: 'Enter' });

    // Enter must not also bubble to Command, whose own Enter handler would click the item again.
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });
});
