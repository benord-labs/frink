// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchScopePills } from './index';

const ROOTS = [
  { path: '/w/app', name: 'app' },
  { path: '/w/api', name: 'api' },
];

afterEach(cleanup);

describe('SearchScopePills', () => {
  it.each([
    [null, ['true', 'false', 'false'], 'api', '/w/api'],
    ['/w/api', ['false', 'false', 'true'], 'All in this tree', null],
  ])('presses only the pill for scope %s, in a named group', (scope, pressed, click, picked) => {
    const onScopeChange = vi.fn();
    render(<SearchScopePills roots={ROOTS} scope={scope} onScopeChange={onScopeChange} />);
    const group = screen.getByRole('group', { name: 'Search scope' });

    expect(
      within(group)
        .getAllByRole('button')
        .map((pill) => [pill.textContent, pill.getAttribute('aria-pressed')]),
    ).toEqual([
      ['All in this tree', pressed[0]],
      ['app', pressed[1]],
      ['api', pressed[2]],
    ]);
    fireEvent.click(within(group).getByRole('button', { name: click }));
    expect(onScopeChange).toHaveBeenCalledWith(picked);
  });

  it("names each project in full, with its folder, in the pill's tooltip", () => {
    render(<SearchScopePills roots={ROOTS} scope={null} onScopeChange={() => {}} />);

    expect(screen.getAllByRole('button').map((pill) => pill.getAttribute('title'))).toEqual([
      null,
      'app · /w/app',
      'api · /w/api',
    ]);
  });
});
