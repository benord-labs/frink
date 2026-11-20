import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

export type HeaderSearch = { placeholder: string; onChange: (text: string) => void };

/** A tab root's header: a large title, and the system search bar where the platform has one. */
export function tabRootOptions(
  title: string,
  search: HeaderSearch | undefined,
  nativeSearch: boolean,
): NativeStackNavigationOptions {
  return {
    title,
    headerLargeTitle: true,
    headerSearchBarOptions:
      nativeSearch && search
        ? {
            placeholder: search.placeholder,
            onChangeText: (event) => search.onChange(event.nativeEvent.text),
          }
        : undefined,
  };
}
