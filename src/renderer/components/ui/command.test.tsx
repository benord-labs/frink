// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Command, CommandItem, CommandList } from './command';

function List({ order }: { order: string[] }) {
  return (
    <Command>
      <CommandList>
        {order.map((value) => (
          <CommandItem key={value} value={value}>
            {value}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

const selected = () =>
  screen.getAllByRole('menuitem').find((el) => el.dataset.selected)?.textContent;

afterEach(cleanup);

describe('Command keyboard navigation', () => {
  it('follows the on-screen order after the items reorder while open', () => {
    const { rerender } = render(<List order={['a', 'b', 'c']} />);
    expect(selected()).toBe('a');

    rerender(<List order={['b', 'a', 'c']} />);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });

    expect(selected()).toBe('c');
  });

  it('selects the first on-screen item when the selected one disappears', () => {
    const { rerender } = render(<List order={['a', 'b']} />);

    rerender(<List order={['c', 'b']} />);

    expect(selected()).toBe('c');
  });
});
