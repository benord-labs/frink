import { describe, expect, it, vi } from 'vitest';
import type { NativeSyntheticEvent, TextInputFocusEventData } from 'react-native';
import { tabRootOptions } from './header-options';

function typed(text: string) {
  // SAFETY: the search bar's handler reads only `nativeEvent.text`.
  return { nativeEvent: { text } } as NativeSyntheticEvent<TextInputFocusEventData>;
}

describe('tabRootOptions', () => {
  it('gives every tab root a large title', () => {
    expect(tabRootOptions('Queue', undefined, true)).toEqual({
      title: 'Queue',
      headerLargeTitle: true,
      headerSearchBarOptions: undefined,
    });
  });

  it('feeds the system search bar into the screen’s query', () => {
    const onChange = vi.fn();
    const options = tabRootOptions('Flows', { placeholder: 'Search flows', onChange }, true);
    expect(options.headerSearchBarOptions?.placeholder).toBe('Search flows');
    options.headerSearchBarOptions?.onChangeText?.(typed('nightly'));
    expect(onChange).toHaveBeenCalledWith('nightly');
  });

  it('leaves search to the page where the header has no search bar', () => {
    const search = { placeholder: 'Search flows', onChange: vi.fn() };
    expect(tabRootOptions('Flows', search, false).headerSearchBarOptions).toBeUndefined();
  });
});
